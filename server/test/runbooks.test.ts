import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DesiredResource } from '../src/cloud/graph.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import type { CloudAccount } from '../src/cloud/types.js';
import type { CloudCredentials } from '../src/cloud/credentials.js';
import { servicePolicy } from '../src/platform/egress.js';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { installCloud, seedAccount } from './cloud-credentials-helpers.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10704): the cloud runbooks in docs/runbooks/ walked through against the DigitalOcean fake
 * (127.0.0.1, never a real cloud), with the routes they document, in the order they document them: credential
 * compromise (cloud-credential-compromise.md), a stuck operation (cloud-stuck-operation.md), budget exceeded
 * (cloud-budget-exceeded.md) and drift (cloud-drift.md). The walk-through against the sandbox accounts is the owner's.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ALLOWED = '127.0.0.1,::1,localhost';
const A = '/api/admin';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

let h: Harness;
let fake: FakeDigitalOcean;
let c: CloudCredentials;
let account: CloudAccount;
let alice: Client;
let bob: Client;
let token: string;
let seq = 0;

const send = (cl: Client, method: 'post' | 'put' | 'patch', url: string, body: object = {}) => cl.agent[method](url).set('x-csrf-token', cl.csrf).send(body);
const net: DesiredResource = { key: 'core', type: 'network', spec: { cidr: '10.20.0.0/20' }, dependsOn: [], protect: false, region: null };
const fw = (ports: string[]): DesiredResource => ({ key: 'web', type: 'firewall', spec: { ingress: ports.map((p) => ({ protocol: 'tcp', ports: p, sources: ['10.0.0.0/8'] })) }, dependsOn: [], protect: false, region: null });

async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const ran = await h.s.jobs.runDue();
    await h.s.cloud.lifecycle.idle();
    if (!ran) {
      const due = await h.s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).first();
      if (!due) return;
    }
  }
}

/** A bare deployment (the console makes one from a deployment spec, `POST /api/admin/cloud/deployments`). */
async function deployment(): Promise<string> {
  const u = (await h.s.db('users').where({ username: 'rb-alice' }).first('id')) as { id: string };
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  return (await h.s.cloud.deployments.create({ principal: { ...p, mfa: true } as Principal, ip: null }, { name: `rb-${++seq}`, accountId: account.id })).id;
}

async function planAndApply(d: string, desired: DesiredResource[], cl = alice) {
  const plan = await send(cl, 'post', `${A}/cloud/deployments/${d}/plans`, { desired });
  expect(plan.status, JSON.stringify(plan.body)).toBe(201);
  const p = plan.body;
  const applied = await send(cl, 'post', `${A}/cloud/deployments/${d}/plans/${p.id}/apply`, { hash: p.hash });
  return { plan: p, applied };
}

beforeAll(async () => {
  h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  c = await installCloud(h);
  fake = await new FakeDigitalOcean().start();
  fake.settleAfter = 1;
  token = fake.addToken();
  const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: fake.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  h.s.cloud.providerFor = (k) => registry.providerFor(k);
  h.s.cloud.engine.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.sleep = async () => undefined;
  const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'rb-do', providerIds: { doTeamId: fake.account.team.uuid } });
  // The token is a vaulted secret of the account, read by the real credential service (no stand-in).
  const stored = await c.store({ scope: 'platform', tenantId: null, accountId: seeded.id, values: { token }, by: null });
  await h.s.db('cloud_credentials').where({ account_id: seeded.id }).update({ refs: JSON.stringify({ token: stored.refs.token }) });
  await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
  account = (await h.s.cloud.accounts.get(seeded.id))!;
  await localUser(h, 'rb-alice', ['system-admin'], 'restricted');
  await localUser(h, 'rb-bob', ['system-admin'], 'restricted');
  alice = await loginAdmin(h, 'rb-alice');
  bob = await loginAdmin(h, 'rb-bob');
});

afterAll(async () => {
  await fake?.stop();
  await h?.close();
});

describe('cloud-credential-compromise.md', () => {
  it('disable, cut the token at the provider, replace it, validate, enable', async () => {
    const d = await deployment();
    // 1. Stop Exprsn-AI using the account.
    const off = await send(alice, 'patch', `${A}/cloud/accounts/${account.id}`, { state: 'disabled' });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    const refused = await send(alice, 'post', `${A}/cloud/deployments/${d}/plans`, { desired: [net] });
    expect([403, 409]).toContain(refused.status);
    // 2. Cut it at the provider (DigitalOcean: delete the token).
    fake.tokens.delete(token);
    // 3. Replace it: the new token goes to the vault only, never back.
    const fresh = fake.addToken();
    const put = await send(alice, 'put', `${A}/cloud/accounts/${account.id}/secret`, { values: { token: fresh } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(fresh);
    const on = await send(alice, 'patch', `${A}/cloud/accounts/${account.id}`, { state: 'active' });
    expect(on.status).toBe(200);
    const v = await send(alice, 'post', `${A}/cloud/accounts/${account.id}/validate`);
    expect(v.status, JSON.stringify(v.body)).toBeLessThan(300);
    expect(JSON.stringify(v.body)).toMatch(/"ok":true/);
    await h.s.db('cloud_accounts').where({ id: account.id }).update({ validation: JSON.stringify(VALIDATED) });
    token = fresh;
    // 4. Check what it did: the audit chain has every step.
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'cloud.%').select('action')) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['cloud.account.updated', 'cloud.credential.stored']));
    const { applied } = await planAndApply(d, [net]);
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    await drain();
  });
});

describe('cloud-drift.md', () => {
  it('check, read the finding, revert it at once, check again', async () => {
    const d = await deployment();
    await planAndApply(d, [fw(['443'])]);
    await drain();
    const fwId = (await h.s.cloud.deployments.resource(d, 'web'))!.providerId!;
    fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } });
    const check = await send(alice, 'post', `${A}/cloud/deployments/${d}/drift/check`);
    expect(check.status).toBe(200);
    const list = await alice.agent.get(`${A}/cloud/deployments/${d}/drift`);
    const findings = (list.body.findings ?? list.body) as { id: string; key: string; state: string }[];
    const f = findings.find((x) => x.key === 'web' && x.state === 'open')!;
    expect(f).toBeTruthy();
    const dec = await send(alice, 'post', `${A}/cloud/deployments/${d}/drift/${f.id}/decide`, { decision: 'revert', apply: true });
    expect(dec.status, JSON.stringify(dec.body)).toBe(200);
    await drain();
    const again = await send(alice, 'post', `${A}/cloud/deployments/${d}/drift/check`);
    expect(again.body.findings).toHaveLength(0);
    expect(fake.firewalls.get(fwId)!.inbound_rules.map((r) => r.ports)).toEqual(['443']);
    expect((await send(alice, 'post', `${A}/cloud/deployments/${d}/verify`)).status).toBe(202);
  });
});

describe('cloud-stuck-operation.md', () => {
  it('see the pending step, cancel the apply job, plan again from what exists, verify', async () => {
    const d = await deployment();
    fake.settleAfter = 1_000_000; // the provider never finishes the firewall
    const maxPoll = h.s.cloud.engine.options.maxPollMs;
    h.s.cloud.engine.options.maxPollMs = 1; // the apply hands the step to cloud.poll at once instead of waiting
    const { plan, applied } = await planAndApply(d, [fw(['443'])]);
    expect(applied.status).toBe(202);
    await h.s.jobs.runDue();
    const ops = await alice.agent.get(`${A}/cloud/deployments/${d}/operations`);
    expect(ops.status).toBe(200);
    expect(JSON.stringify(ops.body)).toMatch(/pending|started/);
    const p = await alice.agent.get(`${A}/cloud/deployments/${d}/plans/${plan.id}`);
    const jobId = (p.body.plan ?? p.body).applyJobId as string;
    expect(jobId).toBeTruthy();
    // The provider lost it, or the deployment is needed now: cancel the apply job.
    const job = await h.s.db('jobs').where({ id: jobId }).first();
    if (job && !['succeeded', 'failed', 'cancelled'].includes(job.state)) {
      const cancel = await send(alice, 'post', `${A}/jobs/${jobId}/cancel`);
      expect(cancel.status, JSON.stringify(cancel.body)).toBeLessThan(300);
    }
    for (const pj of (await h.s.db('jobs').where({ type: 'cloud.poll' }).whereIn('state', ['queued', 'running'])) as { id: string }[]) await send(alice, 'post', `${A}/jobs/${pj.id}/cancel`);
    fake.settleAfter = 1; // the provider recovers
    h.s.cloud.engine.options.maxPollMs = maxPoll;
    await drain();
    // Plan again: it starts from what exists, and nothing is made twice.
    const before = fake.firewalls.size;
    const second = await planAndApply(d, [fw(['443'])]);
    if (second.applied.status === 409) {
      const freshPlan = second.applied.body.freshPlan;
      if (freshPlan) await send(alice, 'post', `${A}/cloud/deployments/${d}/plans/${freshPlan.id}/apply`, { hash: freshPlan.hash });
    }
    await drain();
    expect(fake.firewalls.size).toBe(before);
    expect((await send(alice, 'post', `${A}/cloud/deployments/${d}/verify`)).status).toBe(202);
    await drain();
    expect((await h.s.cloud.deployments.get(d))!.state).toBe('ready');
  });
});

describe('cloud-budget-exceeded.md', () => {
  it('a plan that adds cost is refused past the stop; an override proposed by one admin and approved by another lets it through', async () => {
    const d = await deployment();
    const set = await send(alice, 'put', `${A}/cloud/accounts/${account.id}/budget`, { amount: 10, hardStop: 'actual' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const budgets = h.s.cloud.budgets;
    const real = budgets.statusOf.bind(budgets);
    // Offline there are no API prices, so the plan carries no estimate and a priced create counts as adding cost.
    const estimate = h.s.cloud.estimatePlan;
    (h.s.cloud as { estimatePlan?: unknown }).estimatePlan = undefined;
    const spy = vi.spyOn(budgets, 'statusOf').mockImplementation(async (b, now) => {
      const st = await real(b, now);
      return { ...st, pctActual: 130, stopped: true };
    });
    try {
      const view = await alice.agent.get(`${A}/cloud/accounts/${account.id}/budget`);
      expect(view.body.status).toMatchObject({ stopped: true });
      const vm: DesiredResource = { key: 'app', type: 'vm', spec: { size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' }, dependsOn: [], protect: false, region: null };
      const refused = await send(alice, 'post', `${A}/cloud/deployments/${d}/plans`, { desired: [vm] });
      const rp = refused.body;
      expect(rp.applicable).toBe(false);
      expect(JSON.stringify(rp.blockers)).toMatch(/budget_exceeded/);
      const prop = await send(alice, 'post', `${A}/cloud/accounts/${account.id}/budget/overrides`, { reason: 'Runbook walk-through against the fakes', hours: 1 });
      expect(prop.status, JSON.stringify(prop.body)).toBeLessThan(300);
      const oid = (prop.body.override ?? prop.body).id as string;
      expect((await send(alice, 'post', `${A}/cloud/accounts/${account.id}/budget/overrides/${oid}/approve`)).status).toBe(403);
      const ok = await send(bob, 'post', `${A}/cloud/accounts/${account.id}/budget/overrides/${oid}/approve`);
      expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
      const passes = await send(alice, 'post', `${A}/cloud/deployments/${d}/plans`, { desired: [vm] });
      expect(passes.body.applicable).toBe(true);
      expect((await send(alice, 'post', `${A}/cloud/accounts/${account.id}/budget/overrides/${oid}/revoke`, { note: 'done' })).status).toBeLessThan(300);
    } finally {
      spy.mockRestore();
      (h.s.cloud as { estimatePlan?: unknown }).estimatePlan = estimate;
    }
  });
});
