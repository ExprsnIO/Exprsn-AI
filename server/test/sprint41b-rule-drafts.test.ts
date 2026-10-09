import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama, fakeRuleDraft } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';
import { freeId, normaliseDraft, validateDraft } from '../src/guardrails/drafts.js';
import type { Rule } from '../src/guardrails/rules.js';

/*
 * 1.7.0, Sprint 41b, B-9601 and B-9602: a guardrail rule drafted from a description. The description passes the
 * user-input checkpoint, a profile's model answers one rule, the draft is validated against the rule schema and
 * returned with a diff against the set's working rules, always in shadow; saving puts it in the set's draft in shadow,
 * where it blocks nothing until it is promoted and published under the set's dual control.
 */

describe('rule drafts (B-9601)', () => {
  it('normalises a model answer: a free id, the mechanism kind as the type, shadow, hold wordings as require-approval', () => {
    const working: Rule[] = [{ id: 'card-numbers', name: 'x', checkpoint: 'model-output', type: 'pii', mechanism: { kind: 'pii', detectors: ['payment_card'], threshold: 0.8 }, action: 'warn', stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true }];
    const c = normaliseDraft({ name: 'Card numbers', checkpoint: 'model-output', mechanism: { kind: 'pii', detectors: ['payment_card'] }, action: 'hold', stage: 'enforce' }, working, undefined);
    expect(c).toMatchObject({ id: 'card-numbers-2', type: 'pii', action: 'require-approval', stage: 'shadow', onError: 'closed', enabled: true });
    expect(freeId('bad id!', new Set())).toBe('rule');
    const v = validateDraft(c);
    expect(v.rule?.stage).toBe('shadow');
    expect(v.rule?.mechanism).toMatchObject({ kind: 'pii', detectors: ['payment_card'], threshold: 0.8 });
    // the checkpoint hint fills a missing checkpoint; a pattern RE2 rejects is a problem, not a rule
    expect(normaliseDraft({ name: 'x', mechanism: { kind: 'pattern', pattern: 'a' }, action: 'warn' }, [], 'tool-call').checkpoint).toBe('tool-call');
    const bad = validateDraft(normaliseDraft({ name: 'Repeat', mechanism: { kind: 'pattern', pattern: '(a)\\1' }, action: 'warn' }, [], undefined));
    expect(bad.rule).toBeNull();
    expect(bad.problems[0]).toMatch(/RE2/);
    expect(validateDraft({ name: 'x' }).problems.length).toBeGreaterThan(0);
  });

  it('the fake model drafts a card-number hold on answers from the backlog sentence', () => {
    const text = fakeRuleDraft([{ role: 'system', content: 'You write one guardrail rule for an AI platform from a description.' }, { role: 'user', content: 'hold answers that quote a card number' }]);
    expect(JSON.parse(text)).toMatchObject({ checkpoint: 'model-output', mechanism: { kind: 'pii', detectors: ['payment_card'] }, action: 'require-approval' });
  });
});

describe('rule drafts through the API (B-9601, B-9602)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let admin: Client;
  let second: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const card = 'Pay with 4111 1111 1111 1111 before Friday.';
  const check = (text: string, checkpoint: 'model-output' | 'user-input' = 'model-output') => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId: null, checkpoint, text, label: 'internal' });

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama);
    await localUser(h, 'ga', ['guardrail-admin', 'member'], 'confidential');
    await localUser(h, 'ga2', ['guardrail-admin'], 'confidential');
    admin = await loginAdmin(h, 'ga');
    second = await loginAdmin(h, 'ga2');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function tenantSet(name = 'Finance baseline') {
    return (await post(admin, '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body as { id: string };
  }

  it('drafts "hold answers that quote a card number" in shadow with a diff, saves it in shadow, and it blocks nothing until promoted and published by a second admin', async () => {
    const set = await tenantSet();
    // a draft is a suggestion: validated, diffed, not saved
    const r = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'hold answers that quote a card number', profile: 'general' }).expect(200)).body;
    expect(r.valid).toBe(true);
    expect(r.rule).toMatchObject({ checkpoint: 'model-output', type: 'pii', mechanism: { kind: 'pii', detectors: ['payment_card'] }, action: 'require-approval', stage: 'shadow', enabled: true });
    expect(r.yaml).toContain('stage: shadow');
    expect(r.diff.added.map((x: { id: string }) => x.id)).toEqual([r.rule.id]);
    expect(r.diff.text).toContain('+- id: ' + r.rule.id);
    expect(r.saved).toBeNull();
    expect((await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body.draft).toBeNull();
    const drafted = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'guardrails.rule.drafted' }).first();
    expect(drafted).toBeTruthy();

    // saved: in the set's draft, in shadow, whatever the model said
    const saved = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'hold answers that quote a card number', profile: 'general', save: true }).expect(200)).body;
    expect(saved.saved).toMatchObject({ version: 1, status: 'draft' });
    const detail = (await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body;
    expect(detail.draft.rules).toHaveLength(1);
    expect(detail.draft.rules[0]).toMatchObject({ id: saved.rule.id, stage: 'shadow', action: 'require-approval' });

    // published in shadow: a card number in an answer is recorded, not held
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/submit`).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(403); // dual control: not the proposer
    await post(second, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(200);
    const shadow = await check(card);
    expect(shadow.action).toBe('allow');
    expect(shadow.findings.find((f) => f.ruleId === saved.rule.id)).toMatchObject({ stage: 'shadow', action: 'require-approval' });

    // promoted (no false positives recorded) and published again by the second admin: the answer is held
    await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: saved.rule.id }).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/submit`).expect(200);
    await post(second, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(200);
    const enforced = await check(card);
    expect(enforced.action).toBe('require-approval');
    expect((await check('The quarterly report is attached.')).action).toBe('allow');
  });

  it('refuses a description the content rules block, and an unusable answer is returned with its problems and never saved', async () => {
    const set = await tenantSet();
    // the platform baseline blocks a cloud access key in user input
    const refused = await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'block answers that mention AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', profile: 'general' }).expect(422);
    expect(refused.body.title).toBe('Description refused');
    // prose instead of a rule
    const prose = await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'garbage', profile: 'general', save: true }).expect(422);
    expect(prose.body.title).toBe('Draft not usable');
    // a rule that does not validate (a pattern RE2 rejects) comes back with problems, not saved
    const bad = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'warn on a bad regex with a backreference', profile: 'general' }).expect(200)).body;
    expect(bad.valid).toBe(false);
    expect(bad.rule).toBeNull();
    expect(bad.problems[0]).toMatch(/RE2/);
    const notSaved = await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'warn on a bad regex with a backreference', profile: 'general', save: true }).expect(422);
    expect(notSaved.body.extensions?.problems ?? notSaved.body.problems).toBeTruthy();
    expect((await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body.draft).toBeNull();
    // the checkpoint the console names wins over the model's guess
    const cp = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { prompt: 'flag mentions of "project falcon"', profile: 'general', checkpoint: 'user-input' }).expect(200)).body;
    expect(cp.rule).toMatchObject({ checkpoint: 'user-input', mechanism: { kind: 'pattern' }, action: 'flag', stage: 'shadow' });
  });

  it('is refused on the platform baseline for a tenant admin, needs guardrails:manage, and names inference:invoke when the admin cannot call a model', async () => {
    const { PLATFORM_SET_ID } = await import('../src/guardrails/sets.js');
    const r = await post(admin, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/describe`, { prompt: 'warn on anything', profile: 'general' }).expect(403);
    expect(r.body.detail).toMatch(/Baseline locked/);
    const own = await tenantSet('Second');
    const noInvoke = await post(second, `/api/admin/guardrails/sets/${own.id}/describe`, { prompt: 'warn on anything', profile: 'general' }).expect(403);
    expect(noInvoke.body.detail).toMatch(/inference:invoke/);
    await localUser(h, 'mem', ['member']);
    const m = await (await import('./helpers.js')).login(h, 'mem');
    const set = await tenantSet();
    await m.agent.post(`/api/admin/guardrails/sets/${set.id}/describe`).set('x-csrf-token', m.csrf).send({ prompt: 'warn on anything', profile: 'general' }).expect(403);
  });
});
