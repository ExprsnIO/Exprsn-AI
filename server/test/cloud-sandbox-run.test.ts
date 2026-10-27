import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { CloudSandboxRun, sandboxProfile } from '../src/cloud/sandbox-run.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { createDb } from '../src/db/knex.js';
import * as m148 from '../src/db/migrations/148_cloud_journal.js';
import * as m149 from '../src/db/migrations/149_cloud_lifecycle.js';
import * as m152 from '../src/db/migrations/152_cloud_budgets.js';
import * as m167 from '../src/db/migrations/167_cloud_sandbox_flag.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, testConfig, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10804): the nightly sandbox job against the fakes only (DigitalOcean and Cloudflare on
 * 127.0.0.1; nothing reaches a cloud, EXPRSN_TESTS_OFFLINE holds). The whole cycle, the sweeper deleting only what is
 * tagged and old, the refusal of accounts not marked sandbox, and the stop at the budget. Migrations 148, 149, 152 and
 * 167 are applied here by hand until they are registered.
 */

const ALLOWED = '127.0.0.1,::1,localhost';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }, { feature: 'frontdoor', name: 'Front door', status: 'ok', required: [], missing: [], reason: null }] };
const DAY = 24 * 60 * 60_000;

interface World {
  h: Harness;
  fake: FakeDigitalOcean;
  cf: FakeCloudflare;
  do: CloudAccount;
  flare: CloudAccount;
  actor: CloudActor;
  run: CloudSandboxRun;
}

async function world(): Promise<World> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  for (const m of [m148, m149, m152, m167]) await m.up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.lifecycle.schema.reset();
  h.s.cloud.budgets.resetSchemaCache();
  const fake = await new FakeDigitalOcean().start();
  fake.settleAfter = 1;
  const doToken = fake.addToken();
  const cf = await new FakeCloudflare().start();
  const cfToken = cf.addToken(['Workers R2 Storage Write', 'Workers R2 Storage Read', 'Cloudflare Tunnel Read', 'Workers Scripts Read', 'Containers Read', 'Hyperdrive Read', 'Zone Read', 'DNS Read', 'Account Settings Read'], { accountOwned: true }).value;
  const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: fake.url }, cloudflare: { api: cf.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: CloudAccount) => ({ kind: 'token', token: a.provider === 'cloudflare' ? cfToken : doToken }) };
  h.s.cloud.engine.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.sleep = async () => undefined;
  const doAcc = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'sbx-do', providerIds: { doTeamId: fake.account.team.uuid }, refs: { token: 'vault:cloud/sbx-do#token' } });
  const cfAcc = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'sbx-cf', providerIds: { cloudflareAccountId: cf.accountId }, refs: { token: 'vault:cloud/sbx-cf#token' } });
  for (const a of [doAcc, cfAcc]) await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: JSON.stringify(VALIDATED) });
  const u = await localUser(h, 'nightly', ['system-admin'], 'restricted');
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  const actor: CloudActor = { principal: { ...p, mfa: true } as Principal, ip: null };
  return { h, fake, cf, do: (await h.s.cloud.accounts.get(doAcc.id))!, flare: (await h.s.cloud.accounts.get(cfAcc.id))!, actor, run: new CloudSandboxRun(() => h.s) };
}

const fast = (w: World) => ({ actor: w.actor, pollMs: 0, sleep: async () => undefined, stageTimeoutMs: 60_000 });
const budget = (w: World, a: CloudAccount, amount = 500) => w.h.s.cloud.budgets.set(w.actor, a.id, { amount, hardStop: 'actual' } as never);

describe('cloud:sandbox-run (B-10804)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  }, 120_000);
  afterAll(async () => {
    await w?.fake.stop();
    await w?.cf.stop();
    await w?.h.close();
  });

  it('migration 167 stays within MySQL’s identifier limit and is not registered yet', async () => {
    const db = createDb(testConfig());
    const sql: string[] = [];
    db.on('query', (q: { sql: string }) => void sql.push(q.sql));
    try {
      await (await import('../src/db/migrations/146_cloud_accounts.js')).up(db);
      await (await import('../src/db/migrations/167_cloud_sandbox_flag.js')).up(db);
      expect(await db.schema.hasColumn('cloud_accounts', 'sandbox')).toBe(true);
      await (await import('../src/db/migrations/167_cloud_sandbox_flag.js')).down(db);
      expect(await db.schema.hasTable('cloud_sandbox_runs')).toBe(false);
    } finally {
      await db.destroy();
    }
    const names = sql.flatMap((s) => [...s.matchAll(/(?:index|table|constraint)\s+(?:if\s+not\s+exists\s+)?[`"]([^`"]+)[`"]/gi)].map((m) => m[1]!));
    expect(names.filter((n) => n.length > 64)).toEqual([]);
    const { MIGRATIONS } = (await import('../src/db/migrations/index.js')) as unknown as { MIGRATIONS?: Record<string, unknown> };
    if (MIGRATIONS) expect(Object.keys(MIGRATIONS)).not.toContain('167_cloud_sandbox_flag');
  });

  it('refuses an account not marked sandbox, and one without a budget, before any provider call', async () => {
    const before = w.fake.requests.length;
    const r = await w.run.run({ ...fast(w), accountIds: [w.do.id] });
    expect(r.ok).toBe(false);
    expect(r.accounts[0]).toMatchObject({ status: 'refused', refusal: 'not_sandbox' });
    // Marking needs a budget first.
    await expect(w.run.mark(w.do.id, true, w.actor)).rejects.toThrow(/no monthly budget/);
    await budget(w, w.do);
    await w.h.s.db('cloud_accounts').where({ id: w.flare.id }).update({ sandbox: true });
    const nb = await w.run.run({ ...fast(w), accountIds: [w.flare.id] });
    expect(nb.accounts[0]).toMatchObject({ status: 'refused', refusal: 'no_budget' });
    expect(w.fake.requests.length).toBe(before);
    expect((await w.h.s.db('cloud_sandbox_runs').where({ status: 'refused' })).length).toBe(2);
  });

  it('refuses to mark an account that holds deployments the job did not make', async () => {
    const d = await w.h.s.cloud.deployments.create(w.actor, { name: 'production-app', accountId: w.do.id });
    await expect(w.run.mark(w.do.id, true, w.actor)).rejects.toThrow(/did not make/);
    await w.h.s.db('cloud_deployments').where({ id: d.id }).update({ state: 'destroyed' });
    await w.run.mark(w.do.id, true, w.actor);
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.sandbox.marked' }).first()).toBeTruthy();
  });

  it('runs the whole cycle on DigitalOcean: deploy, verify, drift, revert, upgrade, destroy, and nothing left', async () => {
    const r = await w.run.run({ ...fast(w), accountIds: [w.do.id] });
    const a = r.accounts[0]!;
    expect(a.stages.filter((x) => x.status === 'failed')).toEqual([]);
    expect(a.status).toBe('passed');
    expect(a.stages.map((x) => x.stage)).toEqual(['preflight', 'sweep', 'deploy', 'verify', 'drift', 'revert', 'upgrade', 'verify-upgrade', 'destroy', 'sweep-after', 'leftovers']);
    expect(a.leftovers).toBe(0);
    expect((await w.h.s.cloud.deployments.get(a.deploymentId!))!.state).toBe('destroyed');
    expect(w.fake.firewalls.size).toBe(0);
    expect([...w.fake.vpcs.values()].filter((v) => v.name.startsWith('exprsn-'))).toEqual([]);
    // The drift was made by hand at the provider and audited; the revert and upgrade went through reviewed plans.
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.sandbox.drift' }).first()).toBeTruthy();
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.drift.decided' }).first()).toBeTruthy();
    expect((await w.run.history(w.do.id)).consecutivePasses).toBe(1);
    expect(sandboxProfile('digitalocean').upgrade).not.toEqual(sandboxProfile('digitalocean').deploy);
  }, 120_000);

  it('runs the whole cycle on Cloudflare (drift: a bucket deleted by hand)', async () => {
    await budget(w, w.flare);
    await w.h.s.db('cloud_accounts').where({ id: w.flare.id }).update({ sandbox: true });
    const r = await w.run.run({ ...fast(w), accountIds: [w.flare.id] });
    const a = r.accounts[0]!;
    expect(a.stages.filter((x) => x.status === 'failed')).toEqual([]);
    expect(a).toMatchObject({ status: 'passed', leftovers: 0 });
    expect([...w.cf.buckets.keys()].filter((n) => n.startsWith('exprsn-sbx-cf-'))).toEqual([]);
  }, 120_000);

  it('the sweeper deletes only what is tagged for the account and older than a day; dry run changes nothing', async () => {
    const p = w.h.s.cloud.providers.providerFor('digitalocean');
    const ctx = { account: w.do, cred: { kind: 'token', token: [...w.fake.tokens.keys()][0]! } as never };
    const tags = cloudTags({ account: w.do.name });
    const old = await p.create(ctx, { type: 'firewall', name: 'left-over', idempotencyKey: 'o1', tags, props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['10.0.0.0/8'] }] } } as never);
    const young = await p.create(ctx, { type: 'firewall', name: 'just-made', idempotencyKey: 'o2', tags, props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['10.0.0.0/8'] }] } } as never);
    const oldId = old.done ? old.resource!.providerId : old.resource!.providerId;
    const youngId = young.done ? young.resource!.providerId : young.resource!.providerId;
    // Not Exprsn-AI's: a firewall without the account's name prefix and a VPC without the tags, both long-lived.
    w.fake.firewalls.set('fw-untagged', { id: 'fw-untagged', name: 'ops-ssh', status: 'succeeded', inbound_rules: [], outbound_rules: [], droplet_ids: [], tags: [], created_at: new Date(Date.now() - 30 * DAY).toISOString(), pending_changes: [], reads: 0 });
    w.fake.vpcs.set('vpc-untagged', { id: 'vpc-untagged', urn: 'do:vpc:vpc-untagged', name: 'ops-net', description: '', region: 'fra1', ip_range: '10.99.0.0/20', default: false, created_at: new Date(Date.now() - 30 * DAY).toISOString() });
    // The old one was first seen two days ago (DigitalOcean firewalls report no age the adapter keeps).
    await w.h.s.db('cloud_sandbox_seen').insert({ account_id: w.do.id, resource_type: 'firewall', provider_id: oldId, first_seen: Date.now() - 2 * DAY });
    await w.h.s.db('cloud_sandbox_seen').insert({ account_id: w.do.id, resource_type: 'firewall', provider_id: 'fw-untagged', first_seen: Date.now() - 2 * DAY });

    const dry = await w.run.sweep(w.do, { actor: w.actor, dryRun: true });
    expect(dry.deleted.map((x) => x.providerId)).toEqual([oldId]);
    expect(w.fake.firewalls.has(oldId)).toBe(true);

    const out = await w.run.sweep(w.do, { actor: w.actor });
    expect(out.deleted.map((x) => x.providerId)).toEqual([oldId]);
    expect(out.kept.find((x) => x.providerId === youngId)?.kept).toMatch(/age unknown|younger/);
    expect(w.fake.firewalls.has(oldId)).toBe(false);
    expect(w.fake.firewalls.has(youngId)).toBe(true);
    expect(w.fake.firewalls.has('fw-untagged')).toBe(true);
    expect(w.fake.vpcs.has('vpc-untagged')).toBe(true);
    expect([...out.deleted, ...out.kept].map((x) => x.providerId)).not.toContain('fw-untagged');
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.sandbox.swept' }).first()).toBeTruthy();
    // A day later the young one goes too; the untagged ones never do.
    const later = await w.run.sweep(w.do, { actor: w.actor, now: Date.now() + DAY + 60_000 });
    expect(later.deleted.map((x) => x.providerId)).toEqual([youngId]);
    expect(w.fake.firewalls.has('fw-untagged')).toBe(true);
  }, 120_000);

  it('stops at the budget: refused at or past it, and a cycle that crosses it goes straight to destroy', async () => {
    const budgets = w.h.s.cloud.budgets;
    const real = budgets.statusOf.bind(budgets);
    let pct = 100;
    const spy = vi.spyOn(budgets, 'statusOf').mockImplementation(async (b, now) => ({ ...(await real(b, now)), pctActual: pct }));
    try {
      const refused = await w.run.run({ ...fast(w), accountIds: [w.do.id] });
      expect(refused.accounts[0]).toMatchObject({ status: 'refused', refusal: 'budget_exceeded' });
      // Under the budget at the start, past it once deployed: no upgrade (it adds cost), destroy and sweep still run.
      pct = 10;
      const engine = w.h.s.cloud.engine;
      const verify = engine.verifier.run.bind(engine.verifier);
      const vs = vi.spyOn(engine.verifier, 'run').mockImplementation(async (...args) => {
        const r = await verify(...args);
        pct = 120;
        return r;
      });
      const r = await w.run.run({ ...fast(w), accountIds: [w.do.id] });
      vs.mockRestore();
      const a = r.accounts[0]!;
      expect(a.status).toBe('failed');
      expect(a.stages.find((x) => x.stage === 'upgrade')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/budget_exceeded/) });
      expect(a.stages.find((x) => x.stage === 'verify-upgrade')).toBeUndefined();
      expect(a.stages.find((x) => x.stage === 'destroy')).toMatchObject({ status: 'passed' });
      expect(a.leftovers).toBe(0);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);

  it('the CLI refuses without --as, prints a dry run, and exits 2 on a refusal', async () => {
    const { cloudSandboxCommand } = await import('../src/cli/cloud-sandbox.js');
    const out: string[] = [];
    const write = (t: string) => void out.push(t);
    expect(await cloudSandboxCommand(w.h.s, ['--accounts', w.do.id], write)).toBe(64);
    await w.h.s.db('users').where({ username: 'nightly' }).update({ tenant_id: w.h.tenantId });
    const tenant = await w.h.s.tenants.bySlug(w.h.s.cfg.DEFAULT_TENANT);
    if (tenant?.id === w.h.tenantId) {
      const requests = w.fake.requests.filter((r) => r.method !== 'GET').length;
      expect(await cloudSandboxCommand(w.h.s, ['--accounts', w.do.id, '--as', 'nightly', '--dry-run', '--json'], write)).toBe(0);
      expect(JSON.parse(out.at(-1)!)).toMatchObject({ dryRun: true, accounts: [{ status: 'dry_run' }] });
      expect(w.fake.requests.filter((r) => r.method !== 'GET').length).toBe(requests);
      await w.h.s.db('cloud_accounts').where({ id: w.do.id }).update({ sandbox: false });
      expect(await cloudSandboxCommand(w.h.s, ['--accounts', w.do.id, '--as', 'nightly'], write)).toBe(2);
      await w.h.s.db('cloud_accounts').where({ id: w.do.id }).update({ sandbox: true });
    }
  });

  it('the nightly workflow is scheduled, disabled until the owner enables it, and keeps secrets in files', async () => {
    const { readFileSync } = await import('node:fs');
    const { parse } = await import('yaml');
    const text = readFileSync(new URL('../../.github/workflows/cloud-nightly.yml', import.meta.url), 'utf8');
    const wf = parse(text) as { on: { schedule: { cron: string }[] }; jobs: { sandbox: { if: string; environment: string; steps: { run?: string; env?: Record<string, string> }[] } } };
    expect(wf.on.schedule[0]!.cron).toMatch(/^\d+ \d+ \* \* \*$/);
    expect(wf.jobs.sandbox.if).toContain("vars.CLOUD_SANDBOX_ENABLED == 'true'");
    expect(wf.jobs.sandbox.environment).toBe('cloud-sandbox');
    const run = wf.jobs.sandbox.steps.find((x) => x.run?.includes('cloud:sandbox-run'))!;
    expect(Object.keys(run.env!)).toEqual(expect.arrayContaining(['DATABASE_URL_FILE', 'DATA_KEY_FILE', 'SESSION_SECRET_FILE']));
    expect(Object.keys(run.env!)).not.toContain('DATA_KEY');
    expect(text).not.toMatch(/EXPRSN_TESTS_OFFLINE/);
  });

  it('without migration 167 every account is refused', async () => {
    const h = await harness({});
    try {
      // 146 to 167 are registered (2026-10-21), so the harness has them: roll 167 back to see the job without it.
      if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
      await (await import('../src/db/migrations/167_cloud_sandbox_flag.js')).down(h.s.db);
      const r = await new CloudSandboxRun(() => h.s).run({ actor: w.actor, accountIds: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'] });
      expect(r.accounts[0]).toMatchObject({ status: 'refused', refusal: 'sandbox_flag_missing' });
    } finally {
      await h.close();
    }
  });
});
