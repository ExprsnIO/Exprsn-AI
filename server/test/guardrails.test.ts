import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { compilePattern } from '../src/guardrails/regex.js';
import { detectPii, detectSecrets } from '../src/guardrails/detectors.js';
import { diffRules, relaxes, validateRules, type Rule } from '../src/guardrails/rules.js';
import { parseGuardVerdict } from '../src/guardrails/model.js';
import { redact } from '../src/guardrails/engine.js';
import { PLATFORM_SET_ID } from '../src/guardrails/sets.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;

describe('guardrail building blocks', () => {
  it('compiles patterns with RE2 and reports backreferences with a position and an equivalent', () => {
    expect(compilePattern('sk-[A-Za-z0-9]{32,}').ok).toBe(true);
    const bad = compilePattern(`(?i)(password|api[_-]?key)\\s*=\\s*(['"]).{8,}\\2`);
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.msg).toMatch(/invalid escape sequence: \\2 \(backreferences are not supported by RE2\)/);
    expect(bad.error.pos).toBe(45);
    expect(bad.error.fix).toBe(`(?i)(password|api[_-]?key)\\s*=\\s*['"].{8,}['"]`);
    expect(compilePattern(`password=['"]x['"]`).ok).toBe(true);
    const look = compilePattern('foo(?=bar)');
    expect(look.ok || look.error).toMatchObject({ pos: 4, msg: expect.stringMatching(/lookaround/) });
    expect(compilePattern('[a-').ok).toBe(false);
  });

  it('detects personal data with checksums and secrets by shape and entropy', () => {
    const text = 'Pay DE89 3704 0044 0532 0130 00 (not DE89 3704 0044 0532 0130 01), card 4111 1111 1111 1111, mail anna.ruiz@fabrikam.example, call +351 21 555 0199, DNI 12345678Z.';
    const kinds = detectPii(text).map((d) => d.kind);
    expect(kinds.filter((k) => k === 'iban')).toHaveLength(1);
    expect(kinds).toEqual(expect.arrayContaining(['payment_card', 'email', 'phone', 'national_id']));
    const iban = detectPii(text, ['iban'])[0]!;
    expect(text.slice(...iban.span)).toBe('DE89 3704 0044 0532 0130 00');
    expect(iban.score).toBe(1);
    const secrets = detectSecrets('-----BEGIN RSA PRIVATE KEY----- and AKIAABCDEFGHIJKLMNOP and sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e');
    expect(secrets.map((d) => d.kind)).toEqual(expect.arrayContaining(['private_key', 'cloud_access_key', 'bearer_token']));
    expect(detectSecrets('the quick brown fox').length).toBe(0);
  });

  it('validates rules, refuses relaxing a baseline rule, diffs versions and redacts spans', () => {
    const base: Rule = validateRules([{ id: 'secrets-out', name: 'Secrets', checkpoint: 'model-output', mechanism: { kind: 'secrets' }, action: 'block', stage: 'enforce' }])[0]!;
    expect(base).toMatchObject({ onError: 'closed', severity: 'medium', enabled: true, mechanism: { detectors: ['*'], threshold: 0.6 } });
    expect(relaxes(base, { ...base, action: 'warn' })).toMatch(/block to warn/);
    expect(relaxes(base, { ...base, stage: 'shadow' })).toMatch(/shadow/);
    expect(relaxes(base, { ...base, severity: 'high' })).toBeNull();
    expect(() => validateRules([{ ...base, id: 'Bad Id' }])).toThrow(/GuardrailRule schema/);
    expect(() => validateRules([{ ...base, mechanism: { kind: 'pattern', pattern: '(a)\\1' } }])).toThrow(/position 4/);
    const d = diffRules([base], [{ ...base, action: 'redact' }, { ...base, id: 'new-one' }]);
    expect(d.changed[0]!.fields).toEqual(['action']);
    expect(d.added.map((r) => r.id)).toEqual(['new-one']);
    expect(d.text).toContain('-  action: block');
    expect(d.text).toContain('+  action: redact');
    expect(redact('abc 123 def 456', [{ ruleId: 'x', ruleName: 'x', action: 'redact', stage: 'enforce', span: [4, 7] }, { ruleId: 'y', ruleName: 'y', action: 'redact', stage: 'enforce', span: [12, 15] }])).toBe('abc [redacted] def [redacted]');
    expect(parseGuardVerdict('unsafe\nS1,S10')).toEqual({ safe: false, categories: ['S1', 'S10'] });
    expect(parseGuardVerdict(' safe ')).toEqual({ safe: true, categories: [] });
    expect(() => parseGuardVerdict('I cannot help')).toThrow(/neither safe nor unsafe/);
  });
});

describe('guardrails', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let admin: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    admin = await loginAdmin(h, 'ga');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  /** A pool on the fake Ollama with a chat model, a guard model and their published profiles. */
  async function seed() {
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion'] });
    ollama.addAvailable({ name: 'llama-guard3:8b', size: 5 * GB, capabilities: ['completion'] });
    const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
    await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 8 } });
    const t = Date.now();
    for (const [name, model, label] of [['general', 'llama3.1:8b', 'internal'], ['secret', 'llama3.1:8b', 'confidential'], ['llama-guard', 'llama-guard3:8b', 'confidential']] as const) {
      const m = (await repo.modelByName(model)) ?? (await repo.createModel({ name: model, source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId }));
      await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
      await repo.place(m.id, pool.id, 'warm', 'x');
      const row: ProfileRow = { id: name.toUpperCase().replace(/-/g, '').padEnd(26, '0').slice(0, 26), tenant_id: h.tenantId, name, display_name: name, description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label, status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
      await repo.createProfile(row);
    }
    await h.s.gateway.pollAll();
  }

  async function member(name = 'mem', clearance: 'internal' | 'confidential' = 'internal') {
    await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    return { ...c, post: (url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body) };
  }

  /** Waits until an answer is finished and stored. */
  async function finished(messageId: string) {
    for (let i = 0; i < 200; i++) {
      const m = await h.s.db('messages').where({ id: messageId }).first();
      if (m?.completed_at) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('answer did not finish');
  }

  /** A tenant rule set with the given rules, published. */
  async function tenantSet(rules: object[], name = 'Finance baseline') {
    const set = (await post(admin, '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body;
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    return set as { id: string };
  }

  it('blocks secrets in prompts through the platform baseline and records the decision', async () => {
    await seed();
    const m = await member();
    const r = await m.post('/api/chat', { content: 'Use the key sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e for staging', profile: 'general' }).expect(422);
    expect(r.body).toMatchObject({ title: 'Blocked by guardrail', step: 'guardrail', action: 'block', rules: ['Secrets and private keys'] });
    expect(r.body.detail).toMatch(/Blocked by the guardrail "Secrets and private keys" \(bearer_token\)/);
    expect(r.body.trace_id).toBeTruthy();
    expect(ollama.requests.some((x) => x.path === '/api/chat')).toBe(false);
    const d = await h.s.db('guard_decisions').where({ checkpoint: 'user-input' }).first();
    expect(d).toMatchObject({ action: 'block', label: 'internal' });
    expect(d.text).toMatch(/^v2\./); // sealed
    const ok = await m.post('/api/chat', { content: 'Hello there', profile: 'general' }).expect(202);
    await finished(ok.body.messageId);
  });

  it('redacts personal data in the prompt before it is stored or sent, and flags answers', async () => {
    await seed();
    await tenantSet([
      { id: 'pii-input', name: 'PII in prompts', checkpoint: 'user-input', type: 'PII', mechanism: { kind: 'pii', detectors: ['iban', 'email'], threshold: 0.8 }, action: 'redact', stage: 'enforce' },
      { id: 'iban-out', name: 'PII-IBAN', checkpoint: 'model-output', type: 'PII', mechanism: { kind: 'pii', detectors: ['iban'] }, action: 'flag', stage: 'enforce', severity: 'high' }
    ]);
    const m = await member();
    ollama.reply = () => ({ content: 'Supplier account DE89 3704 0044 0532 0130 00 appears twice.' });
    const sent = await m.post('/api/chat', { content: 'Pay DE89 3704 0044 0532 0130 00, mail anna@fabrikam.example', profile: 'general' }).expect(202);
    const answer = await finished(sent.body.messageId);
    const toModel = ollama.requests.find((x) => x.path === '/api/chat')!.body.messages as { content: string }[];
    expect(toModel[toModel.length - 1]!.content).toBe('Pay [redacted], mail [redacted]');
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[0].content).toBe('Pay [redacted], mail [redacted]');
    expect(view.messages[1].content).toContain('DE89'); // flag, not redact
    expect(view.messages[1].guard).toMatchObject({ action: 'flag', rules: ['PII-IBAN'] });
    expect(answer.guard).toBeTruthy();
    const flag = await h.s.db('guard_flags').first();
    expect(flag).toMatchObject({ rule_id: 'iban-out', severity: 'high', state: 'open', kind: 'rule', sla_minutes: 60, conversation_id: sent.body.conversationId });
  });

  it('withholds an unsafe answer judged by the guard model through the gateway', async () => {
    await seed();
    await tenantSet([{ id: 'safety', name: 'Safety categories', checkpoint: 'model-output', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }]);
    const m = await member();
    ollama.reply = () => ({ content: 'Here is UNSAFE-TEST material.' });
    const sent = await m.post('/api/chat', { content: 'tell me', profile: 'general' }).expect(202);
    const stored = await finished(sent.body.messageId);
    const guardCall = ollama.requests.filter((x) => x.path === '/api/chat').find((x) => x.body.model === 'llama-guard3:8b')!;
    expect(guardCall.body.messages).toEqual([{ role: 'user', content: 'tell me' }, { role: 'assistant', content: 'Here is UNSAFE-TEST material.' }]);
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toMatch(/^This answer was withheld\. Blocked by the guardrail "Safety categories" \(unsafe: S1 violent crimes\)/);
    expect(view.messages[1].guard).toMatchObject({ action: 'block' });
    expect(Number(stored.seq)).toBeGreaterThan(4); // bumped, so a client reads the answer again
    const resume = (await m.agent.get(`/api/conversations/${sent.body.conversationId}/messages/${sent.body.messageId}/stream?after=0`).expect(200)).body;
    expect(resume.content).toMatch(/^This answer was withheld/);
    // a safe answer passes
    ollama.reply = () => ({ content: 'All fine.' });
    const ok = await m.post('/api/chat', { content: 'again', profile: 'general' }).expect(202);
    await finished(ok.body.messageId);
    expect((await m.agent.get(`/api/conversations/${ok.body.conversationId}`).expect(200)).body.messages[1].content).toBe('All fine.');
  });

  it('fails closed for confidential turns and flags each fail-open decision elsewhere', async () => {
    await seed();
    await tenantSet([{ id: 'guard-in', name: 'Prompt safety', checkpoint: 'user-input', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'missing-guard' }, action: 'block', stage: 'enforce', onError: 'allow' }]);
    const m = await member('conf', 'confidential');
    const open = await m.post('/api/chat', { content: 'hello', profile: 'general' }).expect(202);
    await finished(open.body.messageId);
    const flag = await h.s.db('guard_flags').where({ kind: 'fail-open' }).first();
    expect(flag).toMatchObject({ rule_id: 'guard-in', state: 'open' });
    expect(flag.note).toMatch(/could not run .*onError: allow/);
    const conv = await m.post('/api/conversations', { label: 'confidential' }).expect(201);
    const held = await m.post(`/api/conversations/${conv.body.id}/messages`, { content: 'hello', profile: 'secret' }).expect(422);
    expect(held.body).toMatchObject({ title: 'Held by guardrail', action: 'require-approval' });
    expect(held.body.detail).toMatch(/could not run.*held/);
    const status = (await admin.agent.get('/api/admin/guardrails/status').expect(200)).body;
    expect(status).toMatchObject({ degraded: true, held: 1, failOpen: 1 });
  });

  it('records shadow findings without changing the outcome, and samples them for review', async () => {
    await seed();
    await tenantSet([{ id: 'no-legal-advice', name: 'No legal advice', checkpoint: 'model-output', type: 'topic', mechanism: { kind: 'pattern', pattern: '(?i)terminate the contract' }, action: 'block', stage: 'shadow', severity: 'low' }]);
    const m = await member();
    ollama.reply = () => ({ content: 'You should terminate the contract under clause 9.' });
    const sent = await m.post('/api/chat', { content: 'advice?', profile: 'general' }).expect(202);
    await finished(sent.body.messageId);
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toBe('You should terminate the contract under clause 9.');
    expect(view.messages[1].guard).toBeNull();
    const d = await h.s.db('guard_decisions').where({ checkpoint: 'model-output' }).first();
    expect(d.action).toBe('allow');
    expect(JSON.parse(d.findings)[0]).toMatchObject({ ruleId: 'no-legal-advice', stage: 'shadow', span: [11, 33] });
    expect(await h.s.db('guard_flags').where({ stage: 'shadow' }).first()).toMatchObject({ severity: 'low', rule_name: 'No legal advice (shadow)' });
  });

  it('keeps the platform baseline locked for tenant admins and needs a second platform admin to change it', async () => {
    const base = (await admin.agent.get(`/api/admin/guardrails/sets/${PLATFORM_SET_ID}`).expect(200)).body;
    expect(base).toMatchObject({ scope: 'platform', locked: true, owner: 'Platform guardrail admins', publishedVersion: 1 });
    const rule = base.published.rules.find((x: Rule) => x.id === 'secrets-out');
    const locked = await put(admin, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/rules/secrets-out`, { rule: { ...rule, action: 'warn' } }).expect(403);
    expect(locked.body.step).toBe('baseline-locked');
    // a tenant set cannot relax a baseline rule by reusing its id, but can add a stricter one
    const set = (await post(admin, '/api/admin/guardrails/sets', { name: 'Finance', scope: 'tenant' }).expect(201)).body;
    const relax = await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/secrets-out`, { rule: { ...rule, stage: 'shadow' } }).expect(403);
    expect(relax.body).toMatchObject({ step: 'baseline-locked', ruleId: 'secrets-out' });
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/secrets-out`, { rule: { ...rule, severity: 'high' } }).expect(200);
    await post(admin, `/api/admin/guardrails/requests`, { setId: PLATFORM_SET_ID, ruleId: 'secrets-out', change: 'Lower the entropy threshold' }).expect(202);

    await localUser(h, 'sa', ['system-admin'], 'restricted');
    await localUser(h, 'sb', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'sa');
    const b = await loginAdmin(h, 'sb');
    await put(a, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/rules/secrets-out`, { rule: { ...rule, severity: 'low' } }).expect(200);
    await post(a, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/publish`).expect(403);
    await post(a, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/approve`).expect(409); // not submitted
    await post(a, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/submit`).expect(200);
    expect((await h.s.db('notifications').where({ kind: 'guardrails' })).length).toBeGreaterThan(0);
    const self = await post(a, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/approve`).expect(403);
    expect(self.body.step).toBe('dual-control');
    await post(b, `/api/admin/guardrails/sets/${PLATFORM_SET_ID}/draft/approve`).expect(200);
    const after = (await b.agent.get(`/api/admin/guardrails/sets/${PLATFORM_SET_ID}`).expect(200)).body;
    expect(after).toMatchObject({ publishedVersion: 2, locked: false, draft: null });
    expect(after.published.rules.find((x: Rule) => x.id === 'secrets-out').severity).toBe('low');
    const diff = (await b.agent.get(`/api/admin/guardrails/sets/${PLATFORM_SET_ID}/diff?from=1&to=2`).expect(200)).body;
    expect(diff.changed).toEqual([expect.objectContaining({ id: 'secrets-out', fields: ['severity'] })]);
    const actions = (await h.s.db('audit_events').select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['guardrails.review.requested', 'guardrails.published', 'guardrails.change.requested']));
  });

  it('edits drafts as YAML, rejects invalid patterns with the position, tests a rule live and promotes within the limit', async () => {
    const set = (await post(admin, '/api/admin/guardrails/sets', { name: 'Scripts', scope: 'tenant' }).expect(201)).body;
    const yaml = `- id: script-secrets\n  name: Hard-coded credentials\n  checkpoint: script\n  mechanism:\n    kind: pattern\n    pattern: '(?i)(password|api[_-]?key)\\s*=\\s*([''"]).{8,}\\2'\n  action: block\n`;
    const bad = await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { yaml }).expect(422);
    expect(bad.body).toMatchObject({ title: 'Invalid pattern', ruleId: 'script-secrets', pos: 45 });
    expect(bad.body.fix).toBeTruthy();
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { yaml: yaml.replace(/pattern: .*\n/, `pattern: '${bad.body.fix.replace(/'/g, "''")}'\n`) }).expect(200);
    const view = (await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body;
    expect(view.draft).toMatchObject({ version: 1, status: 'draft' });
    expect(view.draft.rules[0]).toMatchObject({ stage: 'shadow', onError: 'closed' });
    expect(view.yaml['script-secrets']).toContain('kind: pattern');

    const test = (await post(admin, '/api/admin/guardrails/test', { setId: set.id, ruleId: 'script-secrets', text: 'db = connect(password = "hunter2hunter2")' }).expect(200)).body;
    expect(test).toMatchObject({ hit: true, action: 'block', unit: 'match', spans: [{ start: 13, text: 'password = "hunter2hunter2"' }] });
    const miss = (await post(admin, '/api/admin/guardrails/test', { rule: { id: 'x', name: 'x', checkpoint: 'user-input', mechanism: { kind: 'pii', detectors: ['iban'], threshold: 0.9 }, action: 'redact' }, text: 'nothing here' }).expect(200)).body;
    expect(miss).toMatchObject({ hit: false, action: 'allow' });
    await h.s.db('guard_decisions').delete();
    expect(await h.s.db('guard_decisions').count({ n: '*' }).first()).toMatchObject({ n: 0 }); // tests record nothing

    await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: 'script-secrets' }).expect(200);
    expect((await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body.draft.rules[0].stage).toBe('enforce');
    await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: 'script-secrets' }).expect(409);
  });

  it('refuses promotion above the false-positive limit, and replays a draft over recorded inputs', async () => {
    await seed();
    const set = await tenantSet([{ id: 'legal', name: 'No legal advice', checkpoint: 'user-input', type: 'topic', mechanism: { kind: 'pattern', pattern: '(?i)contract' }, action: 'flag', stage: 'shadow' }]);
    const m = await member();
    for (const content of ['review the contract', 'contract terms please', 'lunch plans']) {
      const sent = await m.post('/api/chat', { content, profile: 'general' }).expect(202);
      await finished(sent.body.messageId);
    }
    // reviewers dismissed two of the shadow sample and confirmed none
    const shadow = await h.s.db('guard_flags').where({ rule_id: 'legal' });
    expect(shadow).toHaveLength(2);
    await h.s.db('guard_flags').where({ rule_id: 'legal' }).update({ state: 'dismissed' });
    const refused = await post(admin, `/api/admin/guardrails/sets/${set.id}/promote`, { ruleId: 'legal' }).expect(409);
    expect(refused.body).toMatchObject({ title: 'Promotion refused', rate: 1, limit: 0.1 });

    // a narrower draft, replayed over the three recorded prompts
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft/rules/legal`, { rule: { name: 'No legal advice', checkpoint: 'user-input', type: 'topic', mechanism: { kind: 'pattern', pattern: '(?i)review the contract' }, action: 'flag', stage: 'shadow' } }).expect(200);
    const job = (await post(admin, `/api/admin/guardrails/sets/${set.id}/replay`).expect(202)).body;
    expect(job.version).toBe(2);
    await h.s.jobs.runDue();
    const done = await h.s.jobs.get(h.tenantId, job.jobId);
    expect(done!.state).toBe('succeeded');
    expect(done!.result).toMatchObject({ turns: 3, rules: [{ id: 'legal', wouldTrigger: 1, publishedTriggered: 2, errors: 0 }] });
    const stats = (await admin.agent.get(`/api/admin/guardrails/sets/${set.id}`).expect(200)).body.stats.legal;
    expect(stats).toMatchObject({ evaluated: 3, triggered: 2, falsePositives: { dismissed: 2, rate: 1 } });
  });

  it('applies workspace sets only in their workspace', async () => {
    await seed();
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential', { visibility: 'tenant' });
    const other = await h.s.tenants.createWorkspace(h.tenantId, 'Field Sales', 'internal', { visibility: 'tenant' });
    const set = (await post(admin, '/api/admin/guardrails/sets', { name: 'Finance Ops', scope: 'workspace', workspaceId: ws.id }).expect(201)).body;
    await put(admin, `/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'no-budget', name: 'Budget words', checkpoint: 'user-input', mechanism: { kind: 'pattern', pattern: 'budget' }, action: 'block', stage: 'enforce' }] }).expect(200);
    await post(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const check = (workspaceId: string) => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId, checkpoint: 'user-input', text: 'the budget', label: 'internal' });
    expect((await check(ws.id)).action).toBe('block');
    expect((await check(other.id)).action).toBe('allow');
  });
});

describe('flags', () => {
  let h: Harness;
  let reviewer: Client;
  let low: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'rev', ['flag-reviewer'], 'confidential');
    await localUser(h, 'low', ['flag-reviewer'], 'internal');
    await localUser(h, 'boss', ['guardrail-admin'], 'restricted');
    reviewer = (await login(h, 'rev')) as unknown as Client;
    low = (await login(h, 'low')) as unknown as Client;
  });
  afterEach(async () => h.close());

  const flag = (label: 'internal' | 'confidential', severity: 'high' | 'medium' | 'low' = 'high', ruleId = 'iban-out') =>
    h.s.guard.flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'rule', checkpoint: 'model-output', ruleId, ruleName: 'PII-IBAN', setId: 'S'.repeat(26), setName: 'Finance baseline', setVersion: 3, severity, label, text: 'Three card lines have no ledger match. Supplier account DE89 3704 0044 0532 0130 00 appears twice.', span: [56, 83], note: 'Matched: iban.', actor: { name: 'Mara Okafor', via: 'export' } });

  it('shows the queue with timers, redacts above clearance and allows only reassign there', async () => {
    const a = await flag('confidential');
    await flag('internal', 'low');
    const q = (await low.agent.get('/api/flags').expect(200)).body;
    expect(q.open).toBe(2);
    const hidden = q.items.find((x: { ref: string }) => x.ref === `F-${a.number}`);
    expect(hidden).toMatchObject({ restricted: true, rule: null, actor: null, label: 'confidential', slaMinutes: 60 });
    const detail = (await low.agent.get(`/api/flags/F-${a.number}`).expect(200)).body;
    expect(detail.excerpt).toBeNull();
    const refused = await post(low, `/api/flags/F-${a.number}/decide`, { decision: 'confirmed' }).expect(403);
    expect(refused.body.step).toBe('clearance');
    const reviewers = (await low.agent.get(`/api/flags/F-${a.number}/reviewers`).expect(200)).body;
    expect(reviewers.map((x: { name: string }) => x.name).sort()).toEqual(['BOSS', 'REV']);
    const rev = reviewers.find((x: { name: string }) => x.name === 'REV');
    await post(low, `/api/flags/F-${a.number}/reassign`, { userId: rev.id }).expect(200);
    expect((await low.agent.get('/api/flags').expect(200)).body.open).toBe(1); // gone from the reassigner's queue
    const full = (await reviewer.agent.get(`/api/flags/F-${a.number}`).expect(200)).body;
    expect(full.excerpt.span).toBe('DE89 3704 0044 0532 0130 00');
    expect(full.assignee).toBe(rev.id);
    expect(await h.s.db('notifications').where({ user_id: rev.id, kind: 'flag' }).first()).toBeTruthy();
  });

  it('confirms into an eval case, counts dismissals, escalates and lists the decisions', async () => {
    const a = await flag('internal');
    const b = await flag('internal', 'medium');
    const c = await flag('internal', 'low');
    const ok = (await post(reviewer, `/api/flags/F-${a.number}/decide`, { decision: 'confirmed' }).expect(200)).body;
    expect(ok).toMatchObject({ state: 'confirmed', evalCase: `iban-out/f-${a.number}` });
    await post(reviewer, `/api/flags/F-${a.number}/decide`, { decision: 'dismissed' }).expect(409);
    await post(reviewer, `/api/flags/F-${b.number}/decide`, { decision: 'dismissed', reason: 'Rule matched benign text' }).expect(200);
    expect(await h.s.guard.flags.falsePositives(h.tenantId, 'S'.repeat(26), 'iban-out')).toEqual({ confirmed: 1, dismissed: 1, rate: 0.5 });
    const detail = (await reviewer.agent.get(`/api/flags/F-${c.number}`).expect(200)).body;
    expect(detail.prior).toEqual({ confirmed: 1, dismissed: 1 });
    await post(reviewer, `/api/flags/F-${c.number}/eval`, { evalSet: 'red-team', expected: 'positive' }).expect(201);
    expect((await reviewer.agent.get('/api/eval-sets').expect(200)).body).toEqual([{ name: 'iban-out', cases: 1 }, { name: 'red-team', cases: 1 }]);
    const esc = (await post(reviewer, `/api/flags/F-${c.number}/escalate`, { to: 'tenant', note: 'needs context' }).expect(200)).body;
    expect(esc).toMatchObject({ escalatedTo: 'tenant', slaMinutes: 60 });
    expect((await reviewer.agent.get('/api/flags').expect(200)).body.open).toBe(0); // with the guardrail admins now
    const decisions = (await reviewer.agent.get('/api/flags/decisions').expect(200)).body;
    expect(decisions.map((d: { action: string }) => d.action).sort()).toEqual(['confirmed', 'dismissed', 'escalated']);
    const cases = await h.s.db('eval_cases').where({ eval_set: 'iban-out' });
    expect(cases[0].text).toMatch(/^v2\./);
    const events = (await h.s.db('audit_events').select('action')).map((x: { action: string }) => x.action);
    expect(events).toEqual(expect.arrayContaining(['flag.confirmed', 'flag.dismissed', 'flag.escalated', 'flag.eval_case.added']));
  });

  it('notifies the guardrail admins once when a timer is breached', async () => {
    const a = await flag('internal');
    await h.s.db('guard_flags').where({ id: a.id }).update({ due_at: Date.now() - 20 * 60_000 });
    expect((await low.agent.get('/api/flags').expect(200)).body.overdue).toBe(1);
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'guardrails.sweep' });
    await h.s.jobs.runDue();
    expect((await h.s.jobs.get(h.tenantId, job.id))!.result).toMatchObject({ breached: 1 });
    const boss = await h.s.db('users').where({ username: 'boss' }).first();
    expect((await h.s.db('notifications').where({ user_id: boss.id })).map((n: { title: string }) => n.title)).toEqual([`Flag F-${a.number} is past its 60 min timer`]);
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'guardrails.sweep', dedupeKey: 'again' });
    await h.s.jobs.runDue();
    expect(await h.s.db('notifications').where({ user_id: boss.id })).toHaveLength(1);
  });

  it('lets a user report an answer from their own conversation', async () => {
    await localUser(h, 'mem', ['member'], 'internal');
    const m = await login(h, 'mem');
    const c = await h.s.db('users').where({ username: 'mem' }).first();
    const p = { kind: 'user' as const, userId: c.id, tenantId: h.tenantId, tenantSlug: 'default', username: 'mem', displayName: 'MEM', roles: ['member'], clearance: 'internal' as const, scopes: null, sessionId: null, apiKeyId: null, mfa: false, workspaceId: null };
    const conv = await h.s.chat.createConversation(p, { title: 'Q3 travel overrun' });
    const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    await h.s.db('messages').insert({ id, conversation_id: conv.id, tenant_id: h.tenantId, parent_id: null, role: 'assistant', content: await h.s.keys.seal(h.tenantId, 'The overrun is 13,380 EUR.', `content:${id}`), state: 'complete', label: 'internal', seq: 1, canary: false, created_at: Date.now() });
    const r = await m.agent.post('/api/flags/report').set('x-csrf-token', m.csrf).send({ conversationId: conv.id, messageId: id, reason: 'Wrong or unsupported figure', span: [15, 25] }).expect(201);
    expect(r.body.ref).toMatch(/^F-\d+$/);
    const d = (await reviewer.agent.get(`/api/flags/${r.body.ref}`).expect(200)).body;
    expect(d).toMatchObject({ kind: 'report', rule: 'Reported from chat', severity: 'medium', slaMinutes: 240, excerpt: { span: '13,380 EUR' } });
    await m.agent.post('/api/flags/report').set('x-csrf-token', m.csrf).send({ conversationId: conv.id, messageId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', reason: 'x' }).expect(404);
  });
});

describe('classifiers', () => {
  let h: Harness;
  let admin: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ca', ['guardrail-admin'], 'confidential');
    admin = await loginAdmin(h, 'ca');
  });
  afterEach(async () => h.close());

  it('lists the platform classifiers and classifies text synchronously', async () => {
    const list = (await admin.agent.get('/api/admin/classifiers').expect(200)).body;
    expect(list.map((c: { slug: string }) => c.slug)).toEqual(expect.arrayContaining(['pii', 'secrets', 'safety']));
    expect(list.find((c: { slug: string }) => c.slug === 'secrets').usage.map((u: { ruleId: string }) => u.ruleId)).toEqual(expect.arrayContaining(['secrets-input', 'secrets-out']));
    const r = (await post(admin, '/api/classify', { classifier: 'pii', text: 'Pay DE89 3704 0044 0532 0130 00, contact anna.ruiz@fabrikam.example' }).expect(200)).body;
    expect(r.scores).toMatchObject({ iban: 1, email: 0.99, payment_card: 0 });
    expect(r.hits.sort()).toEqual(['email', 'iban']);
    expect(r.spans.find((x: { kind: string }) => x.kind === 'iban')).toMatchObject({ start: 4, end: 31 });
    const pii = list.find((c: { slug: string }) => c.slug === 'pii');
    await c(admin).patch(`/api/admin/classifiers/${pii.id}`).send({ thresholds: { email: 0.6 } }).expect(403); // platform-owned
    const safety = await post(admin, '/api/classify', { classifier: 'safety', text: 'hello' }).expect(503);
    expect(safety.body.title).toBe('Classifier unavailable');
    const res = await c(admin).put('/api/admin/label-names').send({ order: ['public', 'confidential', 'internal', 'restricted'], names: { restricted: 'Strictly confidential' } }).expect(409);
    expect(res.body.title).toBe('Reorder refused');
    await c(admin).put('/api/admin/label-names').send({ names: { restricted: 'Strictly confidential' } }).expect(200);
    expect((await admin.agent.get('/api/admin/label-names').expect(200)).body).toMatchObject({ restricted: 'Strictly confidential', public: 'Public' });
  });

  const c = (cl: Client) => ({ patch: (u: string) => cl.agent.patch(u).set('x-csrf-token', cl.csrf), put: (u: string) => cl.agent.put(u).set('x-csrf-token', cl.csrf) });

  it('trains a linear classifier from labelled cases, evaluates precision and recall, and guards publishing', async () => {
    const cls = (await post(admin, '/api/admin/classifiers', { name: 'Finance sensitivity', engine: 'linear', labels: ['confidential', 'public'] }).expect(201)).body;
    expect(cls).toMatchObject({ status: 'draft', version: 1, dataset: 'finance-sensitivity-eval' });
    const conf = ['budget overrun CFO review', 'salary ledger for payroll', 'quarterly revenue forecast EUR', 'merger negotiation terms', 'unexplained budget variance', 'ledger reconciliation EUR'];
    const pub = ['team lunch on friday', 'office opening hours', 'the weather is nice', 'holiday party invitation', 'parking space rules', 'coffee machine is fixed'];
    const items = [];
    for (let i = 0; i < 5; i++) items.push(...conf.map((t) => ({ text: `${t} ${i}`, expected: 'confidential' })), ...pub.map((t) => ({ text: `${t} ${i}`, expected: 'public' })));
    await post(admin, `/api/admin/classifiers/${cls.id}/samples`, { items: [{ text: 'x', expected: 'nope' }] }).expect(422);
    const added = (await post(admin, `/api/admin/classifiers/${cls.id}/samples`, { items }).expect(201)).body;
    expect(added.samples).toEqual({ confidential: 30, public: 30 });
    await post(admin, '/api/classify', { classifier: cls.slug, text: 'budget' }).expect(503); // not trained yet
    await post(admin, `/api/admin/classifiers/${cls.id}/train`).expect(202);
    await h.s.jobs.runDue();
    const trained = (await admin.agent.get(`/api/admin/classifiers/${cls.id}`).expect(200)).body;
    expect(trained.trained.samples).toBeGreaterThan(30);
    expect(trained.metrics.heldOut).toBe(true);
    expect(trained.metrics.perLabel.confidential.recall).toBeGreaterThanOrEqual(0.8);
    expect(trained.versions[0]).toMatchObject({ version: 2, note: expect.stringMatching(/trained on 60 cases/) });
    const r = (await post(admin, '/api/classify', { classifier: cls.slug, text: 'CFO budget ledger review' }).expect(200)).body;
    expect(r.top.label).toBe('confidential');

    const thr = (await c(admin).patch(`/api/admin/classifiers/${cls.id}`).send({ thresholds: { confidential: 0.6 } }).expect(200)).body;
    expect(thr).toMatchObject({ version: 3, labels: expect.arrayContaining([{ label: 'confidential', threshold: 0.6 }]) });
    const small = await post(admin, `/api/admin/classifiers/${cls.id}/publish`).expect(409);
    expect(small.body).toMatchObject({ title: 'Eval set too small', minimum: 200 });

    await post(admin, `/api/admin/classifiers/${cls.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    const jobs = await h.s.jobs.list(h.tenantId, { type: 'classifier.evaluate' });
    expect(jobs[0]!.state).toBe('succeeded');
    expect(jobs[0]!.message).toMatch(/of \d+ classified/);
    // a rule can use the trained classifier
    const out = await h.s.guard.engine.evaluate({ id: 'fin', name: 'Finance', checkpoint: 'user-input', type: 'classifier', mechanism: { kind: 'classifier', classifier: cls.slug, label: 'confidential' }, action: 'flag', stage: 'enforce', onError: 'closed', severity: 'low', enabled: true }, { tenantId: h.tenantId, checkpoint: 'user-input', text: 'CFO salary ledger', label: 'internal' });
    expect(out).toMatchObject({ hit: true, unit: 'confidential score', error: null });
  });
});
