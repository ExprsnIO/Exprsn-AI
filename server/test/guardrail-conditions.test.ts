import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareValue, evaluateTree, matchedLeaves, treeDepth, treeLeaves, type Tree } from '../src/platform/condition-tree.js';
import { conditionSchema } from '../src/apps/flows.js';
import { conditionProblems, type ConditionTree } from '../src/guardrails/conditions.js';
import { validateRules, type Rule } from '../src/guardrails/rules.js';
import type { ClassifierService } from '../src/guardrails/classifiers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

type L = { v: boolean; name: string };
const leaf = (name: string, v: boolean): L => ({ name, v });

describe('B-157: the shared condition tree', () => {
  const run = (t: Tree<L>) => evaluateTree<L, string>(t, (l) => ({ matched: l.v, detail: l.name }));

  it('evaluates all, any and none, empty groups included, as flows compile them', async () => {
    expect((await run({ all: [leaf('a', true), leaf('b', true)] })).matched).toBe(true);
    expect((await run({ all: [leaf('a', true), leaf('b', false)] })).matched).toBe(false);
    expect((await run({ any: [leaf('a', false), leaf('b', true)] })).matched).toBe(true);
    expect((await run({ any: [leaf('a', false), leaf('b', false)] })).matched).toBe(false);
    expect((await run({ none: [leaf('a', false), leaf('b', false)] })).matched).toBe(true);
    expect((await run({ none: [leaf('a', false), leaf('b', true)] })).matched).toBe(false);
    expect((await run({ all: [] })).matched).toBe(true);
    expect((await run({ any: [] })).matched).toBe(false);
    expect((await run({ none: [] })).matched).toBe(true);
    // nested four deep
    const deep: Tree<L> = { all: [{ any: [{ none: [{ all: [leaf('x', false)] }] }, leaf('y', false)] }, leaf('z', true)] };
    expect(treeDepth(deep)).toBe(4);
    expect(treeLeaves(deep).map((l) => l.name)).toEqual(['x', 'y', 'z']);
    expect((await run(deep)).matched).toBe(true);
  });

  it('stops a group once it is decided, and explains which branch matched', async () => {
    const asked: string[] = [];
    const e = await evaluateTree<L, string>({ any: [{ all: [leaf('a', true), leaf('b', true)] }, leaf('c', true)] }, (l) => {
      asked.push(l.name);
      return { matched: l.v, detail: l.name };
    });
    expect(asked).toEqual(['a', 'b']);
    expect(e).toMatchObject({ kind: 'any', path: '0', matched: true, children: [{ kind: 'all', path: '0.0', matched: true, evaluated: true }, { kind: 'leaf', path: '0.1', evaluated: false }] });
    expect(matchedLeaves(e).map((x) => x.detail)).toEqual(['a', 'b']);
  });

  it('compares values like the flows branch step', () => {
    expect(compareValue('eq', 5, '5')).toBe(true);
    expect(compareValue('eq', ['member', 'editor'], 'editor')).toBe(true);
    expect(compareValue('in', 'feed', ['feed', 'groups'])).toBe(true);
    expect(compareValue('not_in', 'dm', ['feed', 'groups'])).toBe(true);
    expect(compareValue('lt', 3, 7)).toBe(true);
    expect(compareValue('gte', 'x', 1)).toBe(false);
    expect(compareValue('contains', 'hello world', 'wor')).toBe(true);
    expect(compareValue('truthy', [], undefined)).toBe(false);
  });

  it('keeps the flows condition schema as it was', () => {
    expect(conditionSchema.safeParse({ all: [{ field: 'state', op: 'eq', value: 'open' }, { none: [{ field: 'amount', op: 'gt', value: 5 }] }] }).success).toBe(true);
    expect(conditionSchema.safeParse({ every: [] }).success).toBe(false);
    expect(conditionSchema.safeParse({ all: Array.from({ length: 21 }, () => ({ field: 'a', op: 'truthy' })) }).success).toBe(false);
  });
});

describe('B-157: nested conditions on guardrail rules', () => {
  let h: Harness;
  let admin: Client;
  const post = (url: string, body: object = {}) => admin.agent.post(url).set('x-csrf-token', admin.csrf).send(body);
  const put = (url: string, body: object) => admin.agent.put(url).set('x-csrf-token', admin.csrf).send(body);

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ga', ['guardrail-admin', 'member'], 'confidential');
    admin = await loginAdmin(h, 'ga');
  });
  afterEach(async () => h.close());

  const tree = (when: ConditionTree, extra: Partial<Rule> = {}): Rule => validateRules([{ id: 'tree', name: 'Tree rule', checkpoint: 'user-input', type: 'conditions', mechanism: { kind: 'conditions', when }, action: 'flag', stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true, ...extra }])[0]!;
  const evaluate = (rule: Rule, text: string, meta: Record<string, unknown> = {}, label: 'public' | 'internal' | 'confidential' = 'internal', principal?: object) => h.s.guard.engine.evaluate(rule, { tenantId: h.tenantId, checkpoint: rule.checkpoint, text, label, meta, ...(principal ? { principal: principal as never } : {}) });

  it('matches all/any/none trees of patterns and context, and explains the branch', async () => {
    const rule = tree({ all: [{ kind: 'pattern', pattern: '(?i)buy now' }, { any: [{ kind: 'context', field: 'surface', op: 'in', value: ['feed', 'group-post'] }, { kind: 'context', field: 'newAccount', op: 'truthy' }] }, { none: [{ kind: 'context', field: 'role', op: 'eq', value: 'moderator' }] }] });
    const hit = await evaluate(rule, 'Please BUY NOW', { surface: 'feed', role: 'member' });
    expect(hit).toMatchObject({ hit: true, unit: 'conditions', spans: [[7, 14]], error: null });
    expect(hit.explain).toMatchObject({ kind: 'all', matched: true, children: [{ kind: 'leaf', path: '0.0', matched: true, detail: { test: 'pattern (?i)buy now' } }, { kind: 'any', matched: true, children: [{ matched: true, detail: { value: 'feed' } }, { evaluated: false }] }, { kind: 'none', matched: true }] });
    expect(hit.detail).toMatch(/^matched all: pattern/);
    // a new account elsewhere matches through the other branch; a moderator never does
    expect((await evaluate(rule, 'buy now', { surface: 'dm', newAccount: true })).hit).toBe(true);
    expect((await evaluate(rule, 'buy now', { surface: 'dm', newAccount: false })).hit).toBe(false);
    expect((await evaluate(rule, 'buy now', { surface: 'feed', role: 'moderator' })).hit).toBe(false);
    expect((await evaluate(rule, 'hello', { surface: 'feed' })).hit).toBe(false);
  });

  it('reads the account age and new-account fact from the user, and compares labels and channels', async () => {
    const u = (await h.s.db('users').where({ tenant_id: h.tenantId, username: 'ga' }).first('id', 'created_at')) as { id: string };
    const principal = { userId: u.id, tenantId: h.tenantId, roles: ['guardrail-admin', 'member'], clearance: 'confidential' };
    const young = tree({ all: [{ kind: 'context', field: 'accountAgeDays', op: 'lt', value: 7 }, { kind: 'context', field: 'newAccount', op: 'truthy' }, { kind: 'context', field: 'role', op: 'eq', value: 'member' }] });
    expect((await evaluate(young, 'x', {}, 'internal', principal)).hit).toBe(true);
    await h.s.db('users').where({ id: u.id }).update({ created_at: Date.now() - 30 * 86_400_000 });
    const old = await evaluate(young, 'x', {}, 'internal', principal);
    expect(old.hit).toBe(false);
    expect(old.explain!.children![0]).toMatchObject({ matched: false, detail: { value: 30 } });
    // without a person there is no age: the leaf is false, never an error
    expect(await evaluate(young, 'x')).toMatchObject({ hit: false, error: null });
    const labelled = tree({ all: [{ kind: 'context', field: 'label', op: 'gte', value: 'confidential' }, { kind: 'context', field: 'channel', op: 'eq', value: 'grp-1' }] });
    expect((await evaluate(labelled, 'x', { group: 'grp-1' }, 'confidential')).hit).toBe(true);
    expect((await evaluate(labelled, 'x', { group: 'grp-1' }, 'internal')).hit).toBe(false);
  });

  it('takes a threshold per classifier category (S1 0.5, S10 0.8)', async () => {
    const classifiers = h.s.guard.classifiers as ClassifierService & { score: ClassifierService['score'] };
    let scores: Record<string, number> = {};
    let asked = 0;
    classifiers.score = (async () => {
      asked++;
      return { scores, spans: [], top: null, hits: [], engine: 'guard', ms: 1 };
    }) as unknown as ClassifierService['score'];
    const rule = tree({ any: [{ kind: 'category', classifier: 'safety', thresholds: { S1: 0.5, S10: 0.8 } }, { kind: 'category', classifier: 'safety', thresholds: { S11: 0.3 } }] });
    expect(rule.mechanism).toMatchObject({ kind: 'conditions' });
    scores = { S1: 0.6, S10: 0.7 };
    const r1 = await evaluate(rule, 'text');
    expect(r1).toMatchObject({ hit: true, score: 0.7 });
    expect(r1.explain!.children![0]!.detail!.detail).toBe('S1 0.60 at threshold 0.50');
    expect(asked).toBe(1); // asked once for the check, however many leaves read it
    scores = { S1: 0.4, S10: 0.79 };
    expect((await evaluate(rule, 'text')).hit).toBe(false);
    scores = { S10: 0.85 };
    expect((await evaluate(rule, 'text')).hit).toBe(true);
    scores = { S11: 0.31 };
    expect((await evaluate(rule, 'text')).explain!.children!.map((c) => c.matched)).toEqual([false, true]);
    // a classifier that cannot answer makes the rule's onError decide
    classifiers.score = (async () => {
      throw new Error('guard model unavailable');
    }) as unknown as ClassifierService['score'];
    expect(await evaluate(rule, 'text')).toMatchObject({ hit: false, error: 'guard model unavailable' });
  });

  it('reads the spam score from its source, and shows the score and reasons when it matched', async () => {
    const u = (await h.s.db('users').where({ tenant_id: h.tenantId, username: 'ga' }).first('id')) as { id: string };
    const principal = { userId: u.id, tenantId: h.tenantId, roles: ['member'], clearance: 'internal' };
    const calls: string[] = [];
    h.s.guard.engine.spamScore = async (tenantId, userId) => {
      calls.push(`${tenantId}/${userId}`);
      return userId === u.id ? { score: 82, reasons: [{ signal: 'near_duplicates', value: 14, threshold: 5 }] } : null;
    };
    const rule = tree({ all: [{ kind: 'context', field: 'spamScore', op: 'gte', value: 70 }, { kind: 'detector', family: 'pii', detectors: ['email'], threshold: 0.5 }] });
    const hit = await evaluate(rule, 'write to me at bob@example.com', {}, 'internal', principal);
    expect(hit.hit).toBe(true);
    expect(hit.explain!.children![0]).toMatchObject({ matched: true, detail: { value: 82, reasons: [{ signal: 'near_duplicates', value: 14, threshold: 5 }] } });
    expect(calls).toEqual([`${h.tenantId}/${u.id}`]);
    // unknown (no source answer) is false
    const other = await evaluate(rule, 'bob@example.com', {}, 'internal', { ...principal, userId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(other.hit).toBe(false);
    expect(other.explain!.children![0]).toMatchObject({ matched: false, detail: { value: null } });
    expect(other.explain!.children![0]!.detail).not.toHaveProperty('reasons');
  });

  it('reads the spam module\'s own source when no lookup is set on the engine', async () => {
    const { setSpamScoreSource } = await import('../src/guardrails/detectors.js');
    const u = (await h.s.db('users').where({ tenant_id: h.tenantId, username: 'ga' }).first('id')) as { id: string };
    h.s.guard.engine.spamScore = null;
    setSpamScoreSource(async () => ({ score: 91, reasons: [{ signal: 'link_burst', value: 12, threshold: 6 }] }));
    try {
      const rule = tree({ all: [{ kind: 'context', field: 'spamScore', op: 'gte', value: 90 }] });
      const r = await evaluate(rule, 'x', {}, 'internal', { userId: u.id, tenantId: h.tenantId, roles: [], clearance: 'internal' });
      expect(r.hit).toBe(true);
      expect(r.explain!.children![0]!.detail).toMatchObject({ value: 91, reasons: [{ signal: 'link_burst' }] });
    } finally {
      setSpamScoreSource(null);
    }
  });

  it('validates trees: depth, size, operators and patterns', () => {
    const five: ConditionTree = { all: [{ any: [{ none: [{ all: [{ any: [{ kind: 'pattern', pattern: 'x' }] }] }] }] }] };
    expect(conditionProblems(five)).toEqual(['groups nest at most 4 deep']);
    expect(() => tree(five)).toThrow(/nest at most 4/);
    expect(conditionProblems({ all: [{ kind: 'context', field: 'surface', op: 'gt', value: 3 }] })[0]).toMatch(/only accountAgeDays, spamScore and label are ordered/);
    expect(conditionProblems({ all: [{ kind: 'context', field: 'label', op: 'eq', value: 'secret' }] })[0]).toMatch(/not a label/);
    expect(conditionProblems({ all: [{ kind: 'context', field: 'newAccount', op: 'truthy', value: true }] })[0]).toMatch(/takes no value/);
    expect(() => tree({ all: [{ kind: 'pattern', pattern: '(a)\\1' }] })).toThrow(/RE2 rejected a pattern/);
  });

  it('leaves rules without a tree exactly as they were', async () => {
    const plain = validateRules([{ id: 'p', name: 'p', checkpoint: 'user-input', mechanism: { kind: 'pattern', pattern: 'secret' }, action: 'block' }])[0]!;
    expect(plain).toEqual({ id: 'p', name: 'p', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'secret' }, action: 'block', stage: 'shadow', onError: 'closed', severity: 'medium', enabled: true });
    const r = await evaluate(plain, 'a secret here');
    expect(r).toMatchObject({ hit: true, spans: [[2, 8]], score: 1, unit: 'match', detail: '1 match', error: null });
    expect(r).not.toHaveProperty('explain');
  });

  it('runs a tree rule through a published set, and the live test shows the explanation', async () => {
    const set = (await post('/api/admin/guardrails/sets', { name: 'Feed spam', scope: 'tenant' }).expect(201)).body as { id: string };
    const rule = { id: 'feed-links', name: 'Links from new accounts in the feed', checkpoint: 'user-input', type: 'conditions', mechanism: { kind: 'conditions', when: { all: [{ kind: 'pattern', pattern: 'https?://' }, { kind: 'context', field: 'surface', op: 'eq', value: 'feed' }, { kind: 'context', field: 'newAccount', op: 'truthy' }] } }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true };
    await put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [rule] }).expect(200);
    await post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const check = (meta: Record<string, unknown>) => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId: null, checkpoint: 'user-input', text: 'see https://x.example', label: 'internal', meta });
    expect((await check({ objectType: 'feed', newAccount: true })).action).toBe('block');
    expect((await check({ objectType: 'feed', newAccount: false })).action).toBe('allow');
    expect((await check({ via: 'chat', newAccount: true })).action).toBe('allow');
    const live = (await post('/api/admin/guardrails/test', { rule, text: 'see https://x.example', meta: { surface: 'feed', newAccount: true } }).expect(200)).body;
    expect(live).toMatchObject({ hit: true, action: 'block', explain: { kind: 'all', matched: true } });
    expect(live.explain.children.map((c: { matched: boolean }) => c.matched)).toEqual([true, true, true]);
    // too deep is refused at save with the reason
    const deep = { ...rule, mechanism: { kind: 'conditions', when: { all: [{ any: [{ none: [{ all: [{ any: [{ kind: 'pattern', pattern: 'x' }] }] }] }] }] } } };
    const refused = await put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [deep] }).expect(422);
    expect(refused.body.detail).toMatch(/nest at most 4 deep/);
  });
});
