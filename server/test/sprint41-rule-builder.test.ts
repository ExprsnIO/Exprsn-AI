import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RULE_DRAFT_SYSTEM } from '../src/guardrails/drafts.js';
import type { Rule } from '../src/guardrails/rules.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

/** What a model answers for "hold answers that quote a card number". */
const CARD_RULE = { name: 'Hold card numbers in answers', checkpoint: 'model-output', mechanism: { kind: 'pii', detectors: ['payment_card'], threshold: 0.8 }, action: 'require-approval', severity: 'high', description: 'Holds an answer that quotes a payment card number.' };
const CARD_ANSWER = 'The card on file is 4111 1111 1111 1111, expiring in May.';

describe('Sprint 41: the natural-language guardrail builder (B-9601, B-9602)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let admin: Client;
  let second: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
  const view = async (c: Client, id: string) => (await c.agent.get(`/api/admin/guardrails/sets/${id}`).expect(200)).body;
  const check = (text: string) => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId: null, checkpoint: 'model-output', text, label: 'internal' });

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama);
    await localUser(h, 'ga', ['guardrail-admin', 'member'], 'confidential');
    await localUser(h, 'gb', ['guardrail-admin', 'member'], 'confidential');
    admin = await loginAdmin(h, 'ga');
    second = await loginAdmin(h, 'gb');
    ollama.reply = () => ({ content: JSON.stringify(CARD_RULE) });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const newSet = async (name = 'Finance') => (await post(admin, '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body as { id: string };
  const describeRule = (c: Client, setId: string, description = 'hold answers that quote a card number') => post(c, `/api/admin/guardrails/sets/${setId}/describe`, { description, profile: 'general' });

  it('B-9601: a rule drafted from a description validates, saves in shadow and blocks nothing until promoted and approved', async () => {
    const set = await newSet();
    const draft = (await describeRule(admin, set.id).expect(200)).body;
    expect(draft).toMatchObject({ valid: true, problems: [], rule: { id: 'hold-card-numbers-in-answers', checkpoint: 'model-output', action: 'require-approval', stage: 'shadow', onError: 'closed', enabled: true, type: 'PII', mechanism: { kind: 'pii', detectors: ['payment_card'] } } });
    expect(draft.diff).toMatchObject({ added: ['hold-card-numbers-in-answers'], removed: [], changed: [] });
    expect(draft.diff.text).toContain('+- id: hold-card-numbers-in-answers');
    expect(draft.diff.text).toContain('+  stage: shadow');
    expect(draft.yaml).toContain('kind: pii');
    // the model was asked through the profile, with the builder's instruction and the description as the user turn
    const chat = ollama.requests.filter((x) => x.path === '/api/chat').pop()!;
    const sent = (chat.body as { messages: { role: string; content: string }[]; format?: unknown }).messages;
    expect(sent[0]).toMatchObject({ role: 'system' });
    expect(sent[0]!.content).toContain(RULE_DRAFT_SYSTEM.slice(0, 60));
    expect(sent[sent.length - 1]).toMatchObject({ role: 'user', content: 'hold answers that quote a card number' });
    expect((chat.body as { format?: unknown }).format).toBe('json');
    // metered like the app draft assistant, and audited
    expect(await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'workflow' })).toHaveLength(1);
    const drafted = await h.s.db('audit_events').where({ action: 'guardrails.rule.drafted' }).first();
    expect(JSON.parse(drafted.detail)).toMatchObject({ valid: true, rule: 'hold-card-numbers-in-answers', draft: draft.id });
    // nothing is saved by drafting
    expect((await view(admin, set.id)).draft).toBeNull();

    // saving takes the rule as it was drafted: a body is not read, and another admin cannot save it
    await post(second, `/api/admin/guardrails/sets/${set.id}/describe/${draft.id}/save`).expect(404);
    const saved = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe/${draft.id}/save`, { rule: { ...draft.rule, stage: 'enforce', action: 'block' } }).expect(200)).body;
    expect(saved).toMatchObject({ version: 1, status: 'draft', rule: { id: 'hold-card-numbers-in-answers', stage: 'shadow', action: 'require-approval' } });
    await post(admin, `/api/admin/guardrails/sets/${set.id}/describe/${draft.id}/save`).expect(409);
    const v = await view(admin, set.id);
    expect(v.draft.rules).toHaveLength(1);
    expect(v.described['hold-card-numbers-in-answers']).toMatchObject({ profile: 'general', enforceApproved: false, byName: expect.any(String) });
    const added = await h.s.db('audit_events').where({ action: 'guardrails.rule.added' }).first();
    expect(JSON.parse(added.detail)).toMatchObject({ described: true, stage: 'shadow' });

    // published in shadow, it records and holds nothing
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const shadow = await check(CARD_ANSWER);
    expect(shadow.action).toBe('allow');
    expect(shadow.findings).toEqual([expect.objectContaining({ ruleId: 'hold-card-numbers-in-answers', stage: 'shadow' })]);

    // B-9602: replayed over the recorded answer, then promoted; enforcing needs a second guardrail admin
    const job = (await post(admin, `/api/admin/guardrails/sets/${set.id}/replay`).expect(202)).body;
    await h.s.jobs.runDue();
    // two recorded answers: the model's own JSON answer to the description, and the one that quotes a card
    expect((await h.s.jobs.get(h.tenantId, job.jobId))!.result).toMatchObject({ turns: 2, rules: [{ id: 'hold-card-numbers-in-answers', wouldTrigger: 1 }] });
    await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: 'hold-card-numbers-in-answers' }).expect(200);
    const refused = await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(403);
    expect(refused.body).toMatchObject({ step: 'dual-control', rules: ['hold-card-numbers-in-answers'] });
    expect(refused.body.detail).toMatch(/drafted from a description/);
    expect(await h.s.db('audit_events').where({ action: 'guardrails.publish.refused' })).toHaveLength(1);
    expect((await check(CARD_ANSWER)).action).toBe('allow');
    // the second admin cannot publish it directly either
    await post(second, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(403);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/submit`).expect(200);
    expect((await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(403)).body.step).toBe('dual-control');
    expect((await check(CARD_ANSWER)).action).toBe('allow'); // a version under review runs in shadow
    await post(second, `/api/admin/guardrails/sets/${set.id}/draft/approve`).expect(200);
    const held = await check(CARD_ANSWER);
    expect(held.action).toBe('require-approval');
    expect((await check('The quarterly report is attached.')).action).toBe('allow');
    const after = await view(admin, set.id);
    expect(after.described['hold-card-numbers-in-answers'].enforceApproved).toBe(true);
    const published = (await h.s.db('audit_events').where({ action: 'guardrails.published' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(JSON.parse(published.detail)).toMatchObject({ approvedBy: expect.any(String), describedRulesEnforcing: ['hold-card-numbers-in-answers'] });

    // once a second admin approved it, a later edit of the set publishes as before
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/other`, { rule: { name: 'Other', checkpoint: 'user-input', mechanism: { kind: 'pattern', pattern: 'zzz' }, action: 'flag' } }).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
  });

  it('B-9601: the model cannot set the stage, the id or a mechanism that names a profile, and cannot touch the rules that exist', async () => {
    const set = await newSet();
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/hold-card-numbers-in-answers`, { rule: { name: 'Existing', checkpoint: 'user-input', mechanism: { kind: 'pattern', pattern: 'abc' }, action: 'block', stage: 'enforce' } }).expect(200);

    // everything but the fields a draft may set is ignored: stage, enabled, onError, id, extra keys
    ollama.reply = () => ({ content: '```json\n' + JSON.stringify({ ...CARD_RULE, id: 'secrets-out', stage: 'enforce', enabled: false, onError: 'allow', rules: [], remove: ['hold-card-numbers-in-answers'] }) + '\n```' });
    const draft = (await describeRule(admin, set.id).expect(200)).body;
    expect(draft).toMatchObject({ valid: true, rule: { id: 'hold-card-numbers-in-answers-2', stage: 'shadow', enabled: true, onError: 'closed' } });
    expect(Object.keys(draft.rule).sort()).toEqual(['action', 'checkpoint', 'description', 'enabled', 'id', 'mechanism', 'name', 'onError', 'severity', 'stage', 'type']);
    expect(draft.diff).toMatchObject({ added: ['hold-card-numbers-in-answers-2'], removed: [], changed: [] });
    const saved = (await post(admin, `/api/admin/guardrails/sets/${set.id}/describe/${draft.id}/save`).expect(200)).body;
    expect(saved.rule.stage).toBe('shadow');
    const rules = (await view(admin, set.id)).draft.rules as Rule[];
    expect(rules.map((r) => [r.id, r.stage])).toEqual([['hold-card-numbers-in-answers', 'enforce'], ['hold-card-numbers-in-answers-2', 'shadow']]);

    // a name that is a baseline rule's id does not give the draft that id
    ollama.reply = () => ({ content: JSON.stringify({ ...CARD_RULE, name: 'secrets out' }) });
    expect((await describeRule(admin, set.id).expect(200)).body.rule.id).toBe('secrets-out-2');

    // mechanisms that name a profile or a classifier are not drafted; an invalid draft cannot be saved
    for (const mechanism of [{ kind: 'guard-model', profile: 'general', categories: [] }, { kind: 'classifier', classifier: 'pii', label: 'email' }, { kind: 'label', against: 'clearance' }, { kind: 'meta', key: 'sideEffect', values: ['write'] }]) {
      ollama.reply = () => ({ content: JSON.stringify({ ...CARD_RULE, mechanism }) });
      const bad = (await describeRule(admin, set.id).expect(200)).body;
      expect(bad).toMatchObject({ valid: false, id: null, diff: null });
      expect(bad.problems[0]).toMatch(/a drafted rule uses one of pattern, pii, secrets, budget, allow-list/);
    }
    ollama.reply = () => ({ content: JSON.stringify({ ...CARD_RULE, checkpoint: 'everywhere', action: 'delete' }) });
    const invalid = (await describeRule(admin, set.id).expect(200)).body;
    expect(invalid.valid).toBe(false);
    expect(invalid.problems.join(' ')).toMatch(/checkpoint/);
    expect(invalid.problems.join(' ')).toMatch(/action/);
    ollama.reply = () => ({ content: JSON.stringify({ ...CARD_RULE, mechanism: { kind: 'pattern', pattern: '(a)\\1' } }) });
    const pattern = (await describeRule(admin, set.id).expect(200)).body;
    expect(pattern.valid).toBe(false);
    expect(pattern.problems[0]).toMatch(/RE2 rejected the pattern/);
    ollama.reply = () => ({ content: 'I cannot help with that.' });
    await describeRule(admin, set.id).expect(422);
    expect(await h.s.db('guard_rule_drafts').where({ status: 'drafted' })).toHaveLength(0);
    expect((await view(admin, set.id)).draft.rules).toHaveLength(2);
  });

  it('B-9601: the description passes the guardrails, the caller needs inference:invoke, and the baseline stays locked', async () => {
    const set = await newSet();
    // the platform baseline blocks secrets in what a person sends: the description is one such input
    const before = ollama.requests.filter((x) => x.path === '/api/chat').length;
    const refused = await describeRule(admin, set.id, 'block the key sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e in answers').expect(422);
    expect(refused.body.title).toBe('Description refused');
    expect(ollama.requests.filter((x) => x.path === '/api/chat').length).toBe(before);

    // a guardrail admin who may not call a model cannot draft
    await localUser(h, 'gc', ['guardrail-admin'], 'confidential');
    const plain = await loginAdmin(h, 'gc');
    await describeRule(plain, set.id).expect(403);
    // a tenant admin cannot draft into the platform baseline
    const { PLATFORM_SET_ID } = await import('../src/guardrails/sets.js');
    expect((await describeRule(admin, PLATFORM_SET_ID).expect(403)).body.step).toBe('baseline-locked');
    // a draft above the caller's clearance is refused
    await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { description: 'hold card numbers', profile: 'general', label: 'restricted' }).expect(400);
    // an unknown profile is refused by the gateway, and a draft of another set cannot be saved here
    await post(admin, `/api/admin/guardrails/sets/${set.id}/describe`, { description: 'hold card numbers', profile: 'nope' }).expect(404);
    const draft = (await describeRule(admin, set.id).expect(200)).body;
    const other = await newSet('Other');
    await post(admin, `/api/admin/guardrails/sets/${other.id}/describe/${draft.id}/save`).expect(404);
    // describing again replaces the caller's open draft for the set
    const again = (await describeRule(admin, set.id).expect(200)).body;
    await post(admin, `/api/admin/guardrails/sets/${set.id}/describe/${draft.id}/save`).expect(404);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/describe/${again.id}/save`).expect(200);
  });
});
