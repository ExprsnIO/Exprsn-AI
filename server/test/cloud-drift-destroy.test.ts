import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 57 (B-10106, B-10107): drift, destroy, rollback and the orphan sweep, against the DigitalOcean
 * fake on 127.0.0.1 (no network, never a real cloud): its firewalls take hand-made rules, its droplets take final
 * snapshots. Migrations 148 and 149 are applied here by hand until they are registered.
 */

const ALLOWED = '127.0.0.1,::1,localhost';
const D = '/api/admin/cloud/deployments';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

interface World {
  h: Harness;
  fake: FakeDigitalOcean;
  account: CloudAccount;
  /** The person who deploys and asks for destroys. */
  alice: CloudActor & { client: Client };
  /** The second cloud admin. */
  bob: CloudActor & { client: Client };
}

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_drift_findings'))) await (await import('../src/db/migrations/149_cloud_lifecycle.js')).up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.lifecycle.schema.reset();
}

async function person(h: Harness, name: string): Promise<CloudActor & { client: Client }> {
  const u = await localUser(h, name, ['system-admin'], 'restricted');
  const client = await loginAdmin(h, name);
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  const principal: Principal = { ...p, mfa: true };
  return { principal, ip: '127.0.0.1', client };
}

async function world(): Promise<World> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  await install(h);
  const fake = await new FakeDigitalOcean().start();
  fake.settleAfter = 1;
  const token = fake.addToken();
  const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: fake.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token }) };
  h.s.cloud.engine.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.orphans.sleep = async () => undefined;
  const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-main', providerIds: { doTeamId: fake.account.team.uuid }, refs: { token: 'vault:cloud/do-main#token' } });
  await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
  const account = (await h.s.cloud.accounts.get(seeded.id))!;
  return { h, fake, account, alice: await person(h, 'alice'), bob: await person(h, 'bob') };
}

let seq = 0;
const deployment = (w: World) => w.h.s.cloud.deployments.create(w.alice, { name: `dep-${++seq}`, accountId: w.account.id });

const net = (key = 'core', cidr = '10.10.0.0/20'): DesiredResource => ({ key, type: 'network', spec: { cidr }, dependsOn: [], protect: false, region: null });
const fw = (key: string, port = '443', dependsOn: string[] = []): DesiredResource => ({ key, type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: port, sources: ['0.0.0.0/0'] }] }, dependsOn, protect: false, region: null });
const vm = (key: string, network = 'core', protect = false): DesiredResource => ({ key, type: 'vm', spec: { size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' }, dependsOn: [], network, protect, region: null });

/** Runs queued jobs (and the follow-ups of applies that ended) until nothing is left. */
async function drain(w: World): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const ran = await w.h.s.jobs.runDue();
    await w.h.s.cloud.lifecycle.idle();
    if (!ran) {
      const due = await w.h.s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).first();
      if (!due) return;
    }
  }
}

/** Plans, applies through the queue and drains; returns the plan. */
async function applied(w: World, deploymentId: string, desired: DesiredResource[]) {
  const plan = await w.h.s.cloud.plans.create(w.alice, deploymentId, desired);
  await w.h.s.cloud.plans.apply(w.alice, plan.id, plan.hash);
  await drain(w);
  const after = await w.h.s.cloud.plans.load(plan.id);
  expect(after?.state).toBe('applied');
  return plan;
}

const idOf = async (w: World, deploymentId: string, key: string) => (await w.h.s.cloud.deployments.resource(deploymentId, key))!.providerId!;

// ---------------------------------------------------------------- drift

describe('drift (B-10106)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 120_000);
  afterAll(async () => {
    await w.fake.stop();
    await w.h.close();
  });

  it('shows an inbound rule added by hand as drift within one schedule interval, tells the owners, and revert removes it', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [net('core'), fw('web', '443')]);
    const fwId = await idOf(w, d.id, 'web');
    // By hand, at the provider: SSH open to the world.
    w.fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } });

    // The schedule (every CLOUD_DRIFT_MINUTES) queues one cloud.drift per deployment; one interval's run finds it.
    w.h.s.cloud.lifecycle.schedule(w.h.s.scheduler);
    expect(w.h.s.scheduler.get('cloud.drift')?.everyMs).toBe(w.h.s.cfg.CLOUD_DRIFT_MINUTES * 60_000);
    await w.h.s.scheduler.runNow('cloud.drift', null);
    await drain(w);
    const findings = await w.h.s.cloud.lifecycle.drift.findings(w.alice.principal, d.id, { state: 'open' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'field', key: 'web', path: 'ingress', providerId: fwId });
    expect(findings[0]!.observed).toEqual(expect.arrayContaining([expect.objectContaining({ ports: '22' })]));
    // The owners hear of it: who created the deployment and the cloud admins.
    const notes = await w.h.s.db('notifications').where({ kind: 'cloud.drift' }).select('user_id');
    expect(notes.map((n: { user_id: string }) => n.user_id)).toEqual(expect.arrayContaining([w.alice.principal.userId, w.bob.principal.userId]));
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.drift.detected' }).first()).toBeTruthy();
    // A second run does not tell again.
    const again = await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!);
    expect(again.fresh).toHaveLength(0);
    expect(again.open).toHaveLength(1);

    // Revert over the API: a plan back to desired, applied at once (a recent sign-in).
    const res = await w.alice.client.agent.post(`${D}/${d.id}/drift/${findings[0]!.id}/decide`).set('x-csrf-token', w.alice.client.csrf).send({ decision: 'revert', apply: true });
    expect(res.status).toBe(200);
    expect(res.body.finding).toMatchObject({ state: 'reverted', planId: res.body.plan.id });
    expect(res.body.plan).toMatchObject({ purpose: 'revert', summary: { update: 1 } });
    await drain(w);
    expect(w.fake.firewalls.get(fwId)!.inbound_rules.map((r) => r.ports)).toEqual(['443']);
    const clean = await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!);
    expect(clean.open).toHaveLength(0);
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.drift.decided' }).first()).toBeTruthy();
  }, 120_000);

  it('adopts a changed field into the desired spec, and ignores a field in later runs', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [fw('edge', '443')]);
    const fwId = await idOf(w, d.id, 'edge');
    w.fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '80', sources: { addresses: ['0.0.0.0/0'] } });
    const dep = async () => (await w.h.s.cloud.deployments.get(d.id))!;
    const [f] = (await w.h.s.cloud.lifecycle.drift.detect(await dep())).open;
    const adopted = await w.h.s.cloud.lifecycle.drift.decide(w.alice, d.id, f!.id, { decision: 'adopt', note: 'port 80 stays' });
    expect(adopted.finding.state).toBe('adopted');
    const row = (await w.h.s.cloud.deployments.resource(d.id, 'edge'))!;
    expect((row.desired.spec.ingress as { ports: string }[]).map((r) => r.ports).sort()).toEqual(['443', '80']);
    expect((await w.h.s.cloud.lifecycle.drift.detect(await dep())).open).toHaveLength(0);
    // A plan made now changes nothing: the desired state is what the provider has.
    expect((await w.h.s.cloud.plans.create(w.alice, d.id, await w.h.s.cloud.deployments.desiredGraph(d.id))).summary).toMatchObject({ update: 0, noop: 1 });

    w.fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '8080', sources: { addresses: ['10.0.0.0/8'] } });
    const [g] = (await w.h.s.cloud.lifecycle.drift.detect(await dep())).open;
    await w.h.s.cloud.lifecycle.drift.decide(w.alice, d.id, g!.id, { decision: 'ignore' });
    w.fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '9090', sources: { addresses: ['10.0.0.0/8'] } });
    expect((await w.h.s.cloud.lifecycle.drift.detect(await dep())).open).toHaveLength(0);
    // A decided finding is not decided twice.
    await expect(w.h.s.cloud.lifecycle.drift.decide(w.alice, d.id, g!.id, { decision: 'adopt' })).rejects.toMatchObject({ status: 409 });
  }, 120_000);

  it('finds missing resources and unmanaged ones inside a managed network; revert recreates and deletes them', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [net('core', '10.20.0.0/20'), fw('guard', '443')]);
    const netId = await idOf(w, d.id, 'core');
    const fwId = await idOf(w, d.id, 'guard');
    w.fake.firewalls.delete(fwId);
    const stray = 990001;
    w.fake.droplets.set(stray, { id: stray, name: 'handmade', status: 'active', region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', tags: [], vpc_uuid: netId, created_at: new Date().toISOString() });
    const outside = 990002;
    w.fake.droplets.set(outside, { id: outside, name: 'elsewhere', status: 'active', region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', tags: [], vpc_uuid: 'another-vpc', created_at: new Date().toISOString() });
    const out = await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!);
    const byKind = Object.fromEntries(out.open.map((f) => [f.kind, f]));
    expect(out.open).toHaveLength(2);
    expect(byKind.missing).toMatchObject({ key: 'guard', providerId: fwId });
    expect(byKind.unmanaged).toMatchObject({ type: 'vm', providerId: String(stray), detail: expect.stringMatching(/managed network core/) });

    const unmanaged = await w.h.s.cloud.lifecycle.drift.decide(w.alice, d.id, byKind.unmanaged!.id, { decision: 'revert', apply: true });
    expect(unmanaged.plan).toMatchObject({ purpose: 'revert' });
    expect(unmanaged.plan!.steps.find((x) => x.action === 'delete')).toMatchObject({ providerId: String(stray) });
    await drain(w);
    expect(w.fake.droplets.has(stray)).toBe(false);
    expect(w.fake.droplets.has(outside)).toBe(true);
    // A revert plan returns the whole graph to desired: the missing firewall came back with it, so that finding is resolved.
    const after = await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!);
    expect(after.open).toHaveLength(0);
    expect(after.resolved).toBe(1);

    w.fake.firewalls.delete(await idOf(w, d.id, 'guard'));
    const [missing] = (await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!)).open;
    expect(missing).toMatchObject({ kind: 'missing', key: 'guard' });
    const back = await w.h.s.cloud.lifecycle.drift.decide(w.alice, d.id, missing!.id, { decision: 'revert', apply: true });
    expect(back.plan!.steps.find((x) => x.key === 'guard')).toMatchObject({ action: 'create' });
    await drain(w);
    expect([...w.fake.firewalls.values()].some((f) => f.name.endsWith('guard'))).toBe(true);
    expect((await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!)).open).toHaveLength(0);
    w.fake.droplets.delete(outside);
  }, 120_000);
});

// ---------------------------------------------------------------- destroy and rollback

describe('destroy and rollback (B-10107)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 120_000);
  afterAll(async () => {
    await w.fake.stop();
    await w.h.close();
  });

  it('destroys in reverse order, stops at a protected resource until a second admin approves, and snapshots it before deleting it', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [net('core', '10.30.0.0/20'), fw('web', '443'), vm('db1', 'core', true)]);
    const ids = { core: await idOf(w, d.id, 'core'), web: await idOf(w, d.id, 'web'), db1: await idOf(w, d.id, 'db1') };
    w.fake.reset();

    // Alice asks (a recent sign-in); the rest is deleted, the protected droplet and its network stay.
    const asked = await w.alice.client.agent.post(`${D}/${d.id}/destroy`).set('x-csrf-token', w.alice.client.csrf).send({ reason: 'decommissioned' });
    expect(asked.status).toBe(202);
    expect(asked.body.destroy).toMatchObject({ state: 'running', protected: [{ key: 'db1', snapshot: { state: 'none' }, approval: { state: 'pending' } }] });
    await drain(w);
    const destroyId = asked.body.destroy.id as string;
    let x = (await w.h.s.cloud.lifecycle.destroys.get(destroyId))!;
    expect(x.state).toBe('waiting');
    expect(x.rounds).toHaveLength(1);
    expect(w.fake.firewalls.has(ids.web)).toBe(false);
    expect(w.fake.droplets.has(Number(ids.db1))).toBe(true);
    expect(w.fake.vpcs.has(ids.core)).toBe(true);
    expect(w.fake.snapshots.size).toBe(0);
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('destroying');
    expect(await w.h.s.db('notifications').where({ kind: 'cloud.destroy', user_id: w.bob.principal.userId }).first()).toBeTruthy();

    // The person who asked cannot approve; another cloud admin can.
    const self = await w.alice.client.agent.post(`${D}/${d.id}/destroy/${destroyId}/protected/db1/approve`).set('x-csrf-token', w.alice.client.csrf).send({});
    expect(self.status).toBe(403);
    expect(self.body.step).toBe('dual_control');
    expect(w.fake.droplets.has(Number(ids.db1))).toBe(true);
    const ok = await w.bob.client.agent.post(`${D}/${d.id}/destroy/${destroyId}/protected/db1/approve`).set('x-csrf-token', w.bob.client.csrf).send({ note: 'backed up' });
    expect(ok.status).toBe(200);
    expect(ok.body.job).toMatchObject({ type: 'cloud.destroy' });
    await drain(w);

    x = (await w.h.s.cloud.lifecycle.destroys.get(destroyId))!;
    expect(x.state).toBe('finished');
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('destroyed');
    // The final snapshot exists, and it was taken before the droplet was deleted.
    expect(w.fake.snapshots.size).toBe(1);
    const snap = [...w.fake.snapshots.values()][0]!;
    expect(x.protected[0]).toMatchObject({ key: 'db1', deleted: true, approval: { state: 'approved', by: w.bob.principal.userId }, snapshot: { state: 'taken', id: snap.id } });
    expect(snap.name).toMatch(new RegExp(`^exprsn-${d.name}-db1-final-`));
    const snapAt = w.fake.calls('POST /droplets/{id}/actions')[0]!.at;
    const deleteAt = w.fake.calls('DELETE /droplets/{id}')[0]!.at;
    expect(snapAt).toBeLessThanOrEqual(deleteAt);
    expect(w.fake.droplets.size).toBe(0);
    expect(w.fake.vpcs.has(ids.core)).toBe(false);
    // Reverse dependency order: the firewall, then the droplet, then its network.
    const order = w.fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.op);
    expect(order).toEqual(['DELETE /firewalls/{id}', 'DELETE /droplets/{id}', 'DELETE /vpcs/{id}']);
    const actions = (await w.h.s.db('audit_events').whereLike('action', 'cloud.destroy.%').orderBy('seq')).map((e: { action: string }) => e.action);
    expect(actions).toEqual(['cloud.destroy.requested', 'cloud.destroy.approved', 'cloud.destroy.snapshot', 'cloud.destroy.finished']);
  }, 180_000);

  it('refuses to approve a protected resource the provider cannot snapshot, with the reason, and a refusal ends the destroy', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [{ ...fw('vault-edge', '443'), protect: true }, fw('plain', '80')]);
    const { destroy } = await w.h.s.cloud.lifecycle.destroys.request(w.alice, d.id, {});
    expect(destroy.protected[0]).toMatchObject({ key: 'vault-edge', snapshot: { state: 'unsupported', reason: expect.stringMatching(/no snapshot/) } });
    await drain(w);
    await expect(w.h.s.cloud.lifecycle.destroys.approve(w.bob, d.id, destroy.id, 'vault-edge', null)).rejects.toMatchObject({ status: 409, extensions: { reason: 'snapshot_unsupported' } });
    await expect(w.h.s.cloud.lifecycle.destroys.request(w.alice, d.id, {})).rejects.toMatchObject({ status: 409, extensions: { reason: 'destroy_in_progress' } });
    const rejected = await w.h.s.cloud.lifecycle.destroys.reject(w.bob, d.id, destroy.id, 'vault-edge', 'keep it');
    expect(rejected).toMatchObject({ state: 'cancelled' });
    expect((await w.h.s.cloud.deployments.resources(d.id)).map((r) => r.key)).toEqual(['vault-edge']);
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('failed');
  }, 120_000);

  it('rolls replaceable resources back to the last verified state after a failed apply', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [fw('web', '443'), { ...fw('keep', '22'), protect: true }]);
    expect((await w.h.s.cloud.deployments.get(d.id))!.state).toBe('ready');
    expect((await w.h.s.cloud.deployments.lastVerified(d.id)).size).toBe(2);
    const webId = await idOf(w, d.id, 'web');
    // The next apply changes web and adds a firewall whose create the provider refuses: the apply fails.
    w.fake.fail(422, { id: 'unprocessable_entity', message: 'refused by the fake' }, { op: 'POST /firewalls', times: 5 });
    const plan = await w.h.s.cloud.plans.create(w.alice, d.id, [fw('web', '8443'), { ...fw('keep', '22'), protect: true }, fw('extra', '9000')]);
    await w.h.s.cloud.plans.apply(w.alice, plan.id, plan.hash);
    await drain(w);
    expect((await w.h.s.cloud.plans.load(plan.id))!.state).toBe('failed');
    // The rollback ran on its own, as the person who applied: web is back at 443, the failed extra is not in the graph.
    const started = await w.h.s.db('audit_events').where({ action: 'cloud.rollback.started' }).first();
    expect(JSON.parse(started.detail)).toMatchObject({ auto: true, failedPlan: plan.id });
    expect(w.fake.firewalls.get(webId)!.inbound_rules.map((r) => r.ports)).toEqual(['443']);
    expect((await w.h.s.cloud.deployments.resources(d.id)).map((r) => r.key).sort()).toEqual(['keep', 'web']);
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.rollback.finished' }).first()).toBeTruthy();
    // By hand, too: nothing left to change.
    const manual = await w.alice.client.agent.post(`${D}/${d.id}/rollback`).set('x-csrf-token', w.alice.client.csrf).send({});
    expect(manual.status).toBe(202);
    expect(manual.body.job).toBeNull();
  }, 180_000);

  it('sweeps tagged resources no graph or journal knows, adopts one and deletes another', async () => {
    const d = await deployment(w);
    await applied(w, d.id, [net('core', '10.40.0.0/20')]);
    const tags = ['exprsn:managed:true', 'exprsn:account:do-main', `exprsn:deployment:${d.name}`];
    w.fake.droplets.set(880001, { id: 880001, name: 'exprsn-do-main-lost-1', status: 'active', region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', tags: [...tags, 'exprsn:name:lost-1'], vpc_uuid: await idOf(w, d.id, 'core'), created_at: new Date().toISOString() });
    w.fake.droplets.set(880002, { id: 880002, name: 'exprsn-do-main-lost-2', status: 'active', region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', tags: [...tags, 'exprsn:name:lost-2'], vpc_uuid: '', created_at: new Date().toISOString() });
    w.fake.droplets.set(880003, { id: 880003, name: 'someone-elses', status: 'active', region: { slug: 'fra1' }, size_slug: 's-1vcpu-1gb', tags: [], vpc_uuid: '', created_at: new Date().toISOString() });
    const swept = await w.alice.client.agent.post(`${D}/${d.id}/orphans/sweep`).set('x-csrf-token', w.alice.client.csrf).send({});
    expect(swept.status).toBe(200);
    const orphans = swept.body.orphans as { id: string; providerId: string; type: string; deploymentName: string }[];
    expect(orphans.map((o) => o.providerId).sort()).toEqual(['880001', '880002']);
    expect(orphans[0]).toMatchObject({ type: 'vm', deploymentName: d.name });
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.orphan.found' }).first()).toBeTruthy();

    const one = orphans.find((o) => o.providerId === '880001')!;
    const adopted = await w.alice.client.agent.post(`${D}/${d.id}/orphans/${one.id}/adopt`).set('x-csrf-token', w.alice.client.csrf).send({});
    expect(adopted.status).toBe(200);
    expect(adopted.body.resource).toMatchObject({ key: 'lost-1', providerId: '880001', desired: { network: 'core' } });
    const two = orphans.find((o) => o.providerId === '880002')!;
    const del = await w.bob.client.agent.post(`${D}/${d.id}/orphans/${two.id}/delete`).set('x-csrf-token', w.bob.client.csrf).send({});
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ done: true, orphan: { state: 'deleted' } });
    expect(w.fake.droplets.has(880002)).toBe(false);
    expect(w.fake.droplets.has(880003)).toBe(true);
    const journal = await w.h.s.cloud.journal.list(d.id);
    expect(journal.filter((e) => e.providerId === '880002').map((e) => e.state)).toEqual(['started', 'succeeded']);
    // The next sweep finds nothing new: the adopted one is in the graph, the deleted one is gone.
    const again = await w.h.s.cloud.lifecycle.orphans.sweep(w.account);
    expect(again.found).toHaveLength(0);
    w.fake.droplets.delete(880003);
  }, 120_000);
});
