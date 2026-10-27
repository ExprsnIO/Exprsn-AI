/*
 * 1.9.0, Sprint 52 (B-167 to B-169): feature flags. Types and the life cycle with stale warnings; precedence across
 * workspace, tenant, plan (an explicit value and the plan's entitlement) and platform; the sticky percentage rollout
 * and its distribution; the `s.flags` helper with its cache and bus invalidation; flags in the session payload; the
 * workflow branch and app-flow condition on a flag; dual control and recent sign-in on the platform level; the audit
 * trail; and a database without the tables (every flag answers its built-in default).
 *
 * Migration 137 is applied here by hand while it is not registered (guarded by hasTable, so a no-op afterwards).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { down as down137, up as up137 } from '../src/db/migrations/137_feature_flags.js';
import { bucketOf, declareFlag, evaluate, inRollout, isOn, NEXT_STATES, optionsProblem, staleWarnings, unitOf, valueProblem, type FlagDef } from '../src/flags/model.js';
import { FLAGS_TOPIC, type FlagActor } from '../src/flags/service.js';
import { compileFlow, flowInputSchema, type FlowInput } from '../src/apps/flows.js';
import type { AppRow } from '../src/apps/service.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import type { PlanActor } from '../src/billing/plans.js';
import type { SubscriptionActor } from '../src/billing/subscriptions.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const DAY = 86_400_000;

async function flagSchema(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('feature_flags'))) await up137(h.s.db);
  h.s.flags.resetSchemaCache();
}

const def = (over: Partial<FlagDef> = {}): FlagDef => ({
  key: 'beta-search',
  type: 'boolean',
  defaultValue: false,
  options: {},
  description: '',
  owner: '',
  state: 'active',
  stateChangedAt: Date.now(),
  reviewAt: null,
  client: true,
  overridable: true,
  rolloutBy: 'user',
  createdBy: null,
  createdAt: Date.now(),
  updatedBy: null,
  updatedAt: Date.now(),
  ...over
});

describe('B-167 types, life cycle and stale warnings (pure)', () => {
  it('checks values against the type and its options', () => {
    expect(valueProblem('boolean', {}, true)).toBeNull();
    expect(valueProblem('boolean', {}, 'yes')).toMatch(/true or false/);
    expect(valueProblem('number', { min: 0, max: 10 }, 5)).toBeNull();
    expect(valueProblem('number', { min: 0, max: 10 }, 11)).toMatch(/at most 10/);
    expect(valueProblem('number', {}, Number.NaN)).toMatch(/number/);
    expect(valueProblem('variant', { variants: ['a', 'b'] }, 'b')).toBeNull();
    expect(valueProblem('variant', { variants: ['a', 'b'] }, 'c')).toMatch(/one of a, b/);
    expect(optionsProblem('variant', {})).toMatch(/names its variants/);
    expect(optionsProblem('variant', { variants: ['a', 'a'] })).toMatch(/once each/);
    expect(optionsProblem('boolean', { min: 1 })).toMatch(/no options/);
    expect(optionsProblem('number', { min: 5, max: 1 })).toMatch(/above/);
  });

  it('counts on as true, a number above 0 and a variant other than off', () => {
    expect([isOn(true), isOn(false), isOn(3), isOn(0), isOn('blue'), isOn('off'), isOn(null)]).toEqual([true, false, true, false, true, false, false]);
  });

  it('moves along the life cycle only by its transitions', () => {
    expect(NEXT_STATES.planned).toEqual(['active', 'removed']);
    expect(NEXT_STATES.removed).toEqual(['deprecated']);
  });

  it('warns about stale flags', () => {
    const now = Date.now();
    expect(staleWarnings(def({ state: 'deprecated', stateChangedAt: now - 40 * DAY }), null, now).map((w) => w.code)).toEqual(['deprecated-long']);
    expect(staleWarnings(def({ updatedAt: now - 100 * DAY }), null, now).map((w) => w.code)).toEqual(['unchanged']);
    expect(staleWarnings(def({ state: 'planned', stateChangedAt: now - 100 * DAY }), null, now).map((w) => w.code)).toEqual(['planned-long']);
    expect(staleWarnings(def({ reviewAt: now - DAY }), null, now).map((w) => w.code)).toEqual(['review-due']);
    const platform = { id: 'x', flagKey: 'beta-search', scope: 'platform' as const, scopeId: '*', tenantId: null, value: true, rollout: null, note: null, updatedBy: null, updatedAt: now - 40 * DAY };
    expect(staleWarnings(def(), platform, now).map((w) => w.code)).toEqual(['fully-rolled-out']);
    expect(staleWarnings(def({ state: 'removed', stateChangedAt: now - 400 * DAY }), null, now)).toEqual([]);
    expect(staleWarnings(def(), null, now)).toEqual([]);
  });

  it('declares built-in flags once, with a valid default', () => {
    const b = declareFlag({ key: 'test.builtin-a', type: 'number', defaultValue: 3, description: 'x' });
    expect(declareFlag({ key: 'test.builtin-a', type: 'number', defaultValue: 9, description: 'y' })).toBe(b);
    expect(() => declareFlag({ key: 'Bad Key', type: 'boolean', defaultValue: true, description: '' })).toThrow(/key/);
    expect(() => declareFlag({ key: 'test.bad-default', type: 'boolean', defaultValue: 2, description: '' })).toThrow(/true or false/);
  });
});

describe('B-168 rollout (pure)', () => {
  it('is sticky per unit and flag, and only grows with the percentage', () => {
    expect(bucketOf('k', 'user-1')).toBe(bucketOf('k', 'user-1'));
    expect(bucketOf('k', 'user-1')).not.toBe(bucketOf('other', 'user-1'));
    const ids = Array.from({ length: 2000 }, (_, i) => `u${i}`);
    const at = (pct: number) => new Set(ids.filter((id) => inRollout(pct, bucketOf('k', id))));
    const ten = at(10);
    const forty = at(40);
    for (const id of ten) expect(forty.has(id)).toBe(true);
    expect(at(0).size).toBe(0);
    expect(at(100).size).toBe(ids.length);
  });

  it('spreads within tolerance', () => {
    const n = 20_000;
    for (const pct of [5, 25, 50, 90]) {
      let inside = 0;
      for (let i = 0; i < n; i++) if (inRollout(pct, bucketOf('dist-flag', `person-${i}`))) inside++;
      expect(Math.abs(inside / n - pct / 100)).toBeLessThan(0.015);
    }
  });

  it('falls back to the nearest unit the context has', () => {
    expect(unitOf('user', { tenantId: 't', workspaceId: 'w', userId: 'u' })).toEqual({ by: 'user', id: 'u' });
    expect(unitOf('user', { tenantId: 't', workspaceId: 'w' })).toEqual({ by: 'workspace', id: 'w' });
    expect(unitOf('workspace', { tenantId: 't', userId: 'u' })).toEqual({ by: 'tenant', id: 't' });
  });

  it('explains each level and skips one outside its rollout', () => {
    const v = (scope: 'workspace' | 'tenant' | 'plan' | 'platform', value: boolean, rollout: number | null = null) => ({ id: scope, flagKey: 'beta-search', scope, scopeId: scope, tenantId: null, value, rollout, note: null, updatedBy: null, updatedAt: 0 });
    // Find a user outside a 50% rollout.
    let outside = '';
    for (let i = 0; !outside; i++) if (!inRollout(50, bucketOf('beta-search', `u${i}`))) outside = `u${i}`;
    const e = evaluate('beta-search', { tenantId: 't', workspaceId: 'w', userId: outside }, { def: def(), builtin: null, plan: null, values: { workspace: v('workspace', true, 50), tenant: v('tenant', false), platform: v('platform', true) } });
    expect(e.level).toBe('tenant');
    expect(e.value).toBe(false);
    expect(e.steps.find((s) => s.level === 'workspace')!.skipped).toMatch(/outside the 50% rollout/);
    expect(e.steps.find((s) => s.level === 'platform')!.skipped).toMatch(/more specific/);
    // A locked flag ignores tenant and workspace values.
    const locked = evaluate('beta-search', { tenantId: 't', workspaceId: 'w' }, { def: def({ overridable: false }), builtin: null, plan: null, values: { tenant: v('tenant', true) } });
    expect(locked.level).toBe('default');
    // A planned flag answers its default even with values set.
    expect(evaluate('beta-search', { tenantId: 't' }, { def: def({ state: 'planned' }), builtin: null, plan: null, values: { tenant: v('tenant', true) } }).level).toBe('default');
  });
});

describe('feature flags on the server', () => {
  let h: Harness;
  let pa: FlagActor;
  let pb: FlagActor;
  let ta: FlagActor;

  beforeEach(async () => {
    h = await harness();
    await flagSchema(h);
    const ua = await localUser(h, 'pa', ['system-admin'], 'restricted');
    const ub = await localUser(h, 'pb', ['system-admin'], 'restricted');
    const ut = await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    pa = { tenantId: h.tenantId, userId: ua.id, actor: { user: ua.id, username: 'pa' } };
    pb = { tenantId: h.tenantId, userId: ub.id, actor: { user: ub.id, username: 'pb' } };
    ta = { tenantId: h.tenantId, userId: ut.id, actor: { user: ut.id, username: 'ta' } };
  });
  afterEach(async () => {
    await h.close();
  });

  const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

  /** A plan with entitlements, approved, and the tenant subscribed to it since yesterday. */
  async function subscribe(key: string, entitlements: Record<string, boolean | number | string>) {
    const a: PlanActor = pa;
    const { plan } = await h.s.plans.create(a, { key, name: key.toUpperCase(), visibility: 'visible', trialDays: 0, prices: [{ currency: 'USD', months: 1, priceMinor: 1000, seatPriceMinor: 0, includedSeats: 0 }], allowances: {}, entitlements });
    await h.s.plans.approve(pb, plan.id, 1, null);
    await h.s.db('billing_plan_versions').where({ plan_id: plan.id }).update({ effective_from: 0 });
    const sub: SubscriptionActor = { ...pa, platform: true };
    await h.s.subscriptions.subscribe(sub, h.tenantId, { planId: plan.id, seats: 1, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 } }, Date.now() - DAY);
    return plan;
  }

  it('creates flags of each type, refuses bad values, and moves them along the life cycle', async () => {
    await h.s.flags.create(pa, { key: 'new-composer', type: 'boolean', defaultValue: false, description: 'The new composer', owner: 'chat team' });
    await h.s.flags.create(pa, { key: 'answer-style', type: 'variant', defaultValue: 'short', options: { variants: ['short', 'long'] } });
    await h.s.flags.create(pa, { key: 'max-panes', type: 'number', defaultValue: 2, options: { min: 1, max: 6 } });
    await expect(h.s.flags.create(pa, { key: 'max-panes', type: 'number', defaultValue: 2 })).rejects.toMatchObject({ status: 409 });
    await expect(h.s.flags.create(pa, { key: 'bad-variant', type: 'variant', defaultValue: 'x', options: { variants: ['a', 'b'] } })).rejects.toMatchObject({ status: 400 });
    await expect(h.s.flags.create(pa, { key: 'bad-number', type: 'number', defaultValue: 9, options: { max: 5 } })).rejects.toMatchObject({ status: 400 });

    const ctx = { tenantId: h.tenantId };
    expect((await h.s.flags.get('new-composer')).state).toBe('planned');
    expect(await h.s.flags.value(ctx, 'answer-style')).toBe('short');
    await expect(h.s.flags.setState(pa, 'new-composer', 'deprecated')).rejects.toMatchObject({ status: 409 });
    await h.s.flags.setState(pa, 'new-composer', 'active');
    await h.s.flags.setState(pa, 'new-composer', 'deprecated');
    await h.s.flags.setState(pa, 'new-composer', 'removed');
    await expect(h.s.flags.setValue(ta, 'new-composer', 'tenant', null, { value: true, rollout: null })).rejects.toMatchObject({ status: 409 });

    // Stale: a deprecated flag kept for 40 days.
    await h.s.flags.setState(pa, 'answer-style', 'active');
    await h.s.flags.setState(pa, 'answer-style', 'deprecated');
    await h.s.db('feature_flags').where({ key: 'answer-style' }).update({ state_changed_at: Date.now() - 40 * DAY });
    const list = await h.s.flags.list();
    expect(list.find((x) => x.flag.key === 'answer-style')!.stale.map((w) => w.code)).toEqual(['deprecated-long']);
  });

  it('lets the most specific level win: workspace over tenant over plan over platform', async () => {
    const plan = await subscribe('pro', { 'flag.beta-search': true });
    await h.s.flags.create(pa, { key: 'beta-search', type: 'boolean', defaultValue: false, state: 'active' });
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'internal');
    const ctx = { tenantId: h.tenantId, workspaceId: ws.id };

    // The plan's entitlement flag.beta-search.
    let e = await h.s.flags.evaluate(ctx, 'beta-search');
    expect(e).toMatchObject({ level: 'plan', value: true });
    expect(e.steps.find((x) => x.level === 'plan')!.fromEntitlement).toBe(true);

    // An explicit plan value beats the entitlement.
    await h.s.flags.setValue(pa, 'beta-search', 'plan', plan.key, { value: false, rollout: null });
    expect(await h.s.flags.evaluate(ctx, 'beta-search')).toMatchObject({ level: 'plan', value: false });

    // The tenant beats the plan; the workspace beats the tenant.
    await h.s.flags.setValue(ta, 'beta-search', 'tenant', null, { value: true, rollout: null });
    expect(await h.s.flags.evaluate(ctx, 'beta-search')).toMatchObject({ level: 'tenant', value: true });
    await h.s.flags.setValue(ta, 'beta-search', 'workspace', ws.id, { value: false, rollout: null, note: 'not here yet' });
    e = await h.s.flags.evaluate(ctx, 'beta-search');
    expect(e).toMatchObject({ level: 'workspace', value: false, on: false });
    expect(e.reason).toMatch(/workspace/);
    // Another workspace (none set) falls to the tenant.
    expect(await h.s.flags.evaluate({ tenantId: h.tenantId, workspaceId: 'W'.repeat(26) }, 'beta-search')).toMatchObject({ level: 'tenant' });

    // Clearing levels falls back down to the platform, then the default.
    await h.s.flags.clearValue(ta, 'beta-search', 'workspace', ws.id);
    await h.s.flags.clearValue(ta, 'beta-search', 'tenant', null);
    await h.s.flags.clearValue(pa, 'beta-search', 'plan', plan.key);
    await h.s.db('billing_subscriptions').delete();
    await h.s.db('billing_subscription_events').delete();
    h.s.flags.changed(h.tenantId);
    expect(await h.s.flags.evaluate(ctx, 'beta-search')).toMatchObject({ level: 'default', value: false });

    // A workspace of another tenant is refused.
    await expect(h.s.flags.setValue(ta, 'beta-search', 'workspace', 'X'.repeat(26), { value: true, rollout: null })).rejects.toMatchObject({ status: 404 });
    // A locked flag refuses tenant values.
    await h.s.flags.update(pa, 'beta-search', { overridable: false });
    await expect(h.s.flags.setValue(ta, 'beta-search', 'tenant', null, { value: true, rollout: null })).rejects.toMatchObject({ status: 403 });
  });

  it('rolls a value out to a sticky share of people', async () => {
    await h.s.flags.create(pa, { key: 'gradual', type: 'boolean', defaultValue: false, state: 'active' });
    await h.s.flags.setValue(ta, 'gradual', 'tenant', null, { value: true, rollout: 30 });
    const people = Array.from({ length: 2000 }, (_, i) => `person-${i}`);
    const first = await Promise.all(people.map((u) => h.s.flags.on({ tenantId: h.tenantId, userId: u }, 'gradual')));
    const share = first.filter(Boolean).length / people.length;
    expect(Math.abs(share - 0.3)).toBeLessThan(0.04);
    // The same people again: the same answers.
    const again = await Promise.all(people.map((u) => h.s.flags.on({ tenantId: h.tenantId, userId: u }, 'gradual')));
    expect(again).toEqual(first);
    // Growing the rollout keeps everyone who had it.
    await h.s.flags.setValue(ta, 'gradual', 'tenant', null, { value: true, rollout: 60 });
    const grown = await Promise.all(people.map((u) => h.s.flags.on({ tenantId: h.tenantId, userId: u }, 'gradual')));
    first.forEach((was, i) => (was ? expect(grown[i]).toBe(true) : undefined));
    // Sticky by tenant: everyone in the tenant gets the same answer.
    await h.s.flags.update(pa, 'gradual', { rolloutBy: 'tenant' });
    const byTenant = new Set(await Promise.all(people.slice(0, 50).map((u) => h.s.flags.on({ tenantId: h.tenantId, userId: u }, 'gradual'))));
    expect(byTenant.size).toBe(1);
  });

  it('caches evaluations and drops them over the bus', async () => {
    await h.s.flags.create(pa, { key: 'cached', type: 'number', defaultValue: 1, state: 'active' });
    const ctx = { tenantId: h.tenantId };
    expect(await h.s.flags.value(ctx, 'cached')).toBe(1);
    const loads = { ...h.s.flags.loads };
    for (let i = 0; i < 20; i++) await h.s.flags.value(ctx, 'cached');
    expect(h.s.flags.loads).toEqual(loads);

    // A write behind the service's back is not seen until the cache is dropped...
    await h.s.db('feature_flags').where({ key: 'cached' }).update({ default_value: '5' });
    expect(await h.s.flags.value(ctx, 'cached')).toBe(1);
    // ...which another instance does by publishing on the bus (here, delivered locally as Redis would).
    h.s.bus.emitLocal(FLAGS_TOPIC, {});
    expect(await h.s.flags.value(ctx, 'cached')).toBe(5);
    expect(h.s.flags.loads.global).toBe(loads.global + 1);

    // A change through the service publishes for every instance.
    let seen = 0;
    h.s.bus.on(FLAGS_TOPIC, () => void seen++);
    await h.s.flags.setValue(ta, 'cached', 'tenant', null, { value: 7, rollout: null });
    expect(seen).toBe(1);
    expect(await h.s.flags.value(ctx, 'cached')).toBe(7);

    // Unknown and built-in flags.
    declareFlag({ key: 'test.builtin-b', type: 'boolean', defaultValue: true, description: 'built in' });
    expect(await h.s.flags.on(ctx, 'test.builtin-b')).toBe(true);
    expect(await h.s.flags.value(ctx, 'no-such-flag')).toBeNull();
    expect(await h.s.flags.on(ctx, 'no-such-flag')).toBe(false);
  });

  it('sends client flags with the session, /api/me and /api/me/flags', async () => {
    await h.s.flags.create(pa, { key: 'console-x', type: 'boolean', defaultValue: false, state: 'active' });
    await h.s.flags.create(pa, { key: 'server-only', type: 'boolean', defaultValue: true, state: 'active', client: false });
    await h.s.flags.setValue(ta, 'console-x', 'tenant', null, { value: true, rollout: null });
    await localUser(h, 'mem', ['member']);
    const mem = await login(h, 'mem');
    expect(mem.res.body.flags).toEqual({ 'console-x': true });
    expect((await mem.agent.get('/api/auth/session').expect(200)).body.flags).toEqual({ 'console-x': true });
    expect((await mem.agent.get('/api/me').expect(200)).body.flags).toEqual({ 'console-x': true });
    expect((await mem.agent.get('/api/me/flags').expect(200)).body).toEqual({ flags: { 'console-x': true } });
    // A member cannot read or change the flags themselves.
    await mem.agent.get('/api/admin/feature-flags').expect(403);
    await send(mem, 'put', '/api/admin/feature-flags/console-x/tenant', { value: false }).expect(403);
  });

  it('branches a workflow on a flag, and compiles an app flow condition on one', async () => {
    await h.s.flags.create(pa, { key: 'wf-path', type: 'boolean', defaultValue: false, state: 'active' });
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const admin = await loginAdmin(h, 'wadmin');
    const graph: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'manual' } },
        { id: 'check', kind: 'branch', title: 'Flag on?', x: 230, y: 24, config: { flag: 'wf-path', op: 'truthy' } },
        { id: 'yes', kind: 'transform', title: 'Yes', x: 440, y: 24, config: { fields: { path: 'new' } } },
        { id: 'no', kind: 'transform', title: 'No', x: 440, y: 152, config: { fields: { path: 'old' } } }
      ],
      edges: [
        { from: 'trigger', to: 'check' },
        { from: 'check', to: 'yes', branch: 'true' },
        { from: 'check', to: 'no', branch: 'false' }
      ],
      limits: {}
    } as WfGraph;
    expect(validateGraph(graph, { label: 'internal', profile: () => undefined }).errors).toEqual([]);
    // A branch names a value or a flag, not both.
    const both = structuredClone(graph);
    both.nodes[1]!.config = { flag: 'wf-path', left: '{{input}}', op: 'truthy' };
    expect(validateGraph(both, { label: 'internal', profile: () => undefined }).ok).toBe(false);

    const w = (await send(admin, 'post', '/api/workflows', { name: 'flagged', label: 'internal' }).expect(201)).body;
    await send(admin, 'put', `/api/workflows/${w.id}/draft`, { graph, rev: w.draftRev }).expect(200);
    await send(admin, 'post', `/api/workflows/${w.id}/publish`, { note: 'v1' }).expect(200);
    const runOnce = async () => {
      const started = (await send(admin, 'post', `/api/workflows/${w.id}/runs`, { input: {} }).expect(202)).body;
      await h.s.jobs.runDue();
      const run = (await admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
      return Object.fromEntries(run.steps.map((s: { nodeId: string; state: string }) => [s.nodeId, s.state]));
    };
    expect(await runOnce()).toMatchObject({ check: 'passed', yes: 'skipped', no: 'passed' });
    await h.s.flags.setValue(ta, 'wf-path', 'tenant', null, { value: true, rollout: null });
    expect(await runOnce()).toMatchObject({ check: 'passed', yes: 'passed', no: 'skipped' });

    // App flows: a `flag` leaf compiles to a branch step on the flag.
    const app = { id: 'A'.repeat(26), name: 'crm', title: 'CRM', label: 'internal' } as AppRow;
    const flow: FlowInput = flowInputSchema.parse({ name: 'f', entity: 'deal', trigger: { kind: 'manual' }, match: { field: 'flag', flag: 'wf-path', op: 'truthy' }, actions: [{ type: 'wait', minutes: 1 }] });
    const g = compileFlow(app, flow);
    expect(g.nodes.find((n) => n.kind === 'branch')).toMatchObject({ config: { flag: 'wf-path', op: 'truthy' }, title: 'flag wf-path is true' });
  });

  it('puts a live flag\'s platform default and rollout under dual control and a recent sign-in, over HTTP', async () => {
    const a = await loginAdmin(h, 'pa');
    const b = await loginAdmin(h, 'pb');
    const t = await loginAdmin(h, 'ta');
    await send(a, 'post', '/api/admin/feature-flags', { key: 'dual', type: 'boolean', defaultValue: false, description: 'Dual control', owner: 'platform' }).expect(201);
    // Planned: the change applies at once.
    expect((await send(a, 'put', '/api/admin/feature-flags/dual/platform', { platform: { value: true, rollout: 10 } }).expect(200)).body.applied).toBe(true);
    await send(a, 'post', '/api/admin/feature-flags/dual/state', { state: 'active' }).expect(200);
    // Live: it waits for a second platform admin.
    const proposed = (await send(a, 'put', '/api/admin/feature-flags/dual/platform', { defaultValue: true, reason: 'ready' }).expect(202)).body;
    expect(proposed).toMatchObject({ applied: false, proposal: { state: 'pending', mine: true } });
    await send(a, 'put', '/api/admin/feature-flags/dual/platform', { defaultValue: true }).expect(409);
    expect((await h.s.flags.get('dual')).defaultValue).toBe(false);
    await send(a, 'post', `/api/admin/feature-flags/proposals/${proposed.proposal.id}/approve`, {}).expect(403);
    await send(t, 'post', `/api/admin/feature-flags/proposals/${proposed.proposal.id}/approve`, {}).expect(403);
    await send(b, 'post', `/api/admin/feature-flags/proposals/${proposed.proposal.id}/approve`, { note: 'ok' }).expect(200);
    expect((await h.s.flags.get('dual')).defaultValue).toBe(true);
    // A second proposal, withdrawn by its proposer.
    const second = (await send(b, 'put', '/api/admin/feature-flags/dual/platform', { platform: null }).expect(202)).body;
    expect((await send(b, 'post', `/api/admin/feature-flags/proposals/${second.proposal.id}/reject`, {}).expect(200)).body.state).toBe('withdrawn');

    // A recent sign-in: an old session is asked to step up.
    await h.s.db('sessions').update({ auth_at: Date.now() - 2 * 3600_000, created_at: Date.now() - 2 * 3600_000 });
    const stale = await send(a, 'put', '/api/admin/feature-flags/dual/platform', { defaultValue: false });
    expect(stale.status).toBe(401);
    expect(stale.body.step_up).toBe(true);

    // The tenant admin sees and sets the tenant's own values only.
    const list = (await t.agent.get('/api/admin/feature-flags').expect(200)).body;
    expect(list).toMatchObject({ available: true, canManage: false });
    expect(list.flags[0].platform).toBeUndefined();
    await send(t, 'put', '/api/admin/feature-flags/dual/tenant', { value: false, rollout: 50 }).expect(200);
    await send(t, 'post', '/api/admin/feature-flags', { key: 'mine', type: 'boolean', defaultValue: false }).expect(403);
    await send(t, 'put', '/api/admin/feature-flags/dual/plans/pro', { value: true }).expect(403);
    const why = (await t.agent.get('/api/admin/feature-flags/dual/explain').expect(200)).body;
    expect(why.steps.map((s: { level: string }) => s.level)).toEqual(['workspace', 'tenant', 'plan', 'platform']);
    await t.agent.get(`/api/admin/feature-flags/dual/explain?tenant=${'Z'.repeat(26)}`).expect(403);
    await send(t, 'delete', '/api/admin/feature-flags/dual/tenant').expect(204);
  });

  it('audits every change as flag.*', async () => {
    const plan = await subscribe('team', {});
    await h.s.flags.create(pa, { key: 'audited', type: 'boolean', defaultValue: false });
    await h.s.flags.update(pa, 'audited', { description: 'now described' });
    await h.s.flags.changePlatform(pa, 'audited', { defaultValue: true }, null);
    await h.s.flags.setState(pa, 'audited', 'active');
    const p = await h.s.flags.changePlatform(pa, 'audited', { platform: { value: false, rollout: 20 } }, 'try');
    await h.s.flags.approve(pb, p.proposal!.id);
    const q = await h.s.flags.changePlatform(pa, 'audited', { defaultValue: false }, null);
    await h.s.flags.reject(pb, q.proposal!.id, 'no');
    await h.s.flags.setValue(pa, 'audited', 'plan', plan.key, { value: true, rollout: null });
    await h.s.flags.setValue(ta, 'audited', 'tenant', null, { value: true, rollout: null });
    await h.s.flags.clearValue(ta, 'audited', 'tenant', null);
    const rows = (await h.s.db('audit_events').where('action', 'like', 'flag.%').orderBy('seq')) as { action: string; label: string; target: string }[];
    expect(rows.map((r) => r.action)).toEqual(['flag.feature.created', 'flag.feature.updated', 'flag.platform.changed', 'flag.feature.state_changed', 'flag.change.proposed', 'flag.change.approved', 'flag.change.proposed', 'flag.change.rejected', 'flag.value.set', 'flag.value.set', 'flag.value.cleared']);
    expect(new Set(rows.map((r) => r.label))).toEqual(new Set(['internal']));
    expect((await h.s.audit.verify(h.tenantId)).status).toBe('verified');
  });

  it('answers built-in defaults and says flags are unavailable without the tables', async () => {
    await down137(h.s.db);
    h.s.flags.resetSchemaCache();
    declareFlag({ key: 'test.builtin-c', type: 'variant', defaultValue: 'calm', options: { variants: ['calm', 'loud'] }, description: '' });
    const ctx = { tenantId: h.tenantId, userId: 'someone' };
    expect(await h.s.flags.value(ctx, 'test.builtin-c')).toBe('calm');
    expect(await h.s.flags.on(ctx, 'anything')).toBe(false);
    expect(await h.s.flags.forClient(ctx)).toEqual({});
    const a = await loginAdmin(h, 'pa');
    expect((await a.agent.get('/api/admin/feature-flags').expect(200)).body).toMatchObject({ available: false, flags: [] });
    const refused = await send(a, 'post', '/api/admin/feature-flags', { key: 'x-flag', type: 'boolean', defaultValue: false }).expect(503);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect((await a.agent.get('/api/me').expect(200)).body.flags).toEqual({});
    await up137(h.s.db);
    h.s.flags.resetSchemaCache();
    expect(await h.s.flags.available()).toBe(true);
  });
});
