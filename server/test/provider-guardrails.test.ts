import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAccount } from '../src/cloud/types.js';
import { guardrailCategories } from '../src/gateway/bedrock-server.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws, type FakeAwsKey } from './fake-aws.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10506): a Bedrock Guardrail as an extra layer, against the Bedrock fake only. Attached
 * through `guardrailConfig` (Converse and ConverseStream) or called with ApplyGuardrail on the prompt and the answer;
 * its interventions recorded as guardrail decisions (provider `bedrock`, rule name "Bedrock Guardrail", one finding
 * per policy that fired, never the matched text); Exprsn-AI's own checkpoints run before and after whatever it
 * decides, and turning the Bedrock Guardrail off (or removing it) never turns one of them off.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Bedrock Guardrail as a provider layer (B-10506)', () => {
  let h: Harness;
  const aws = new FakeAws();
  let key: FakeAwsKey;
  let account: CloudAccount;
  let admin: Client;
  let member: Client;
  let instanceId = '';
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
  const setGuardrail = (guardrail: object | null) => put(admin, `/api/admin/cloud/model-servers/${instanceId}/guardrail`, { guardrail });

  const chat = async (content: string) => {
    const res = await post(member, '/api/chat', { content, profile: 'claude-guarded' });
    // Exprsn-AI's user-input checkpoint refuses a blocked prompt before any message is made.
    if (res.status === 422) return { id: null, state: 'refused' };
    expect(res.status).toBe(202);
    const sent = res.body as { messageId: string };
    let msg: { state: string } | undefined;
    for (let i = 0; i < 800; i++) {
      msg = await h.s.db('messages').where({ id: sent.messageId }).first();
      if (msg && ['complete', 'failed', 'blocked', 'held'].includes(msg.state)) break;
      await sleep(25);
    }
    return { id: sent.messageId, state: msg?.state ?? 'missing' };
  };
  const decisions = async (since: number) => (await h.s.db('guard_decisions').where({ tenant_id: h.tenantId }).andWhere('created_at', '>=', since).orderBy('created_at')) as { checkpoint: string; action: string; findings: string; meta: string; source_kind: string | null }[];
  const providerDecisions = async (since: number) => (await decisions(since)).filter((d) => JSON.parse(d.meta).provider === 'bedrock');

  beforeAll(async () => {
    await aws.start();
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.modelImport.resetSchemaCache();
    key = { accessKeyId: 'ASIAFAKEGUARDRAIL01', secretAccessKey: 'fake-secret-for-guardrails', sessionToken: 'fake-guard-session', arn: `arn:aws:sts::${aws.account}:assumed-role/exprsn-read/s`, status: 'Active', createdAt: Date.now() };
    aws.keys.set(key.accessKeyId, key);
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, sessionToken: key.sessionToken, expiresAt: Date.now() + 3_600_000 }) };
    account = await seedAccount(h, { provider: 'aws', mode: 'federated', name: 'aws-guarded', providerIds: { awsAccountId: aws.account } });
    h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
    aws.bedrock.guardrails.set('gr7finance', { id: 'gr7finance', name: 'Finance guard', versions: ['1', '2'], topic: /stock tips/i, violence: /attack plan/i, email: true });
    await localUser(h, 'gca', ['model-admin', 'tenant-admin', 'cloud-admin'], 'confidential');
    await localUser(h, 'gcb', ['model-admin'], 'confidential');
    await localUser(h, 'gcm', ['member'], 'internal');
    admin = await loginAdmin(h, 'gca');
    const second = await loginAdmin(h, 'gcb');
    member = await login(h, 'gcm');
    // A Bedrock instance, Claude imported, evaluated, approved by a second admin, a profile on it.
    const pool = (await post(admin, '/api/admin/pools', { name: 'bedrock-guarded', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    instanceId = (await post(admin, `/api/admin/pools/${pool.id}/instances`, { name: 'bedrock-guarded-1', kind: 'bedrock', deploy: 'docker', cloud: { accountId: account.id, region: 'eu-central-1' } }).expect(201)).body.id;
    const imp = (await post(admin, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: [HAIKU] }).expect(201)).body;
    const modelId = imp.results[0].modelId as string;
    await post(admin, `/api/admin/models/${modelId}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    await post(second, `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(200);
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'GUARDED0000000000000000001', tenant_id: h.tenantId, name: 'claude-guarded', display_name: 'Claude (guarded)', description: null, alias_of: null, model_id: modelId, pool_id: pool.id, num_ctx: 4096, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t } as never);
    // Exprsn-AI's own rules: one before the model (user-input), one after it (model-output).
    const rule = (id: string, checkpoint: string, pattern: string) => ({ id, name: id, checkpoint, type: 'pattern', mechanism: { kind: 'pattern', pattern }, action: 'block', stage: 'enforce', onError: 'allow', severity: 'high', enabled: true });
    const set = await h.s.guard.sets.create(h.tenantId, { name: 'Tenant: finance', scope: 'tenant' }, 'test');
    await h.s.guard.sets.saveDraft(set, [rule('exprsn-in', 'user-input', 'NIGHTSHADE'), rule('exprsn-out', 'model-output', 'CODEWORD-OUT')] as never, 'test');
    await h.s.guard.sets.publish(await h.s.guard.sets.get(h.tenantId, set.id), 'reviewer');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await aws.stop();
  });

  beforeEach(() => {
    aws.bedrock.reply = (c) => {
      const last = [...(c.body.messages ?? [])].reverse().find((m) => m.role === 'user');
      const text = String((last?.content ?? []).find((b) => typeof b.text === 'string')?.text ?? '');
      if (/plan please/i.test(text)) return { text: 'Here is the attack plan you asked for.' };
      if (/codeword/i.test(text)) return { text: 'The answer is CODEWORD-OUT.' };
      return { text: 'All clear.' };
    };
  });

  it('maps a guardrail assessment to categories without the matched text', () => {
    const cats = guardrailCategories([{ topicPolicy: { topics: [{ name: 'Investment advice', type: 'DENY', action: 'BLOCKED' }] }, contentPolicy: { filters: [{ type: 'VIOLENCE', confidence: 'HIGH', action: 'BLOCKED' }, { type: 'HATE', confidence: 'NONE', action: 'NONE' }] }, sensitiveInformationPolicy: { piiEntities: [{ type: 'EMAIL', action: 'ANONYMIZED' }] } }]);
    expect(cats).toEqual([
      { category: 'topic:investment_advice', filtered: true, detected: true },
      { category: 'content:violence', filtered: true, detected: true, severity: 'high' },
      { category: 'content:hate', filtered: false, detected: false, severity: 'none' },
      { category: 'pii:email', filtered: true, detected: true }
    ]);
  });

  it('sets the guardrail on the Bedrock instance only once Bedrock confirms it, and audits it', async () => {
    expect((await setGuardrail({ id: 'gr-missing', version: '1' }).expect(400)).body.detail).toBeTruthy(); // not an id
    expect((await setGuardrail({ id: 'grmissing', version: '1' }).expect(409)).body.reason).toBe('guardrail_unconfirmed');
    expect((await setGuardrail({ id: 'gr7finance', version: '3' }).expect(409)).body.reason).toBe('guardrail_unconfirmed');
    await put(member, `/api/admin/cloud/model-servers/${instanceId}/guardrail`, { guardrail: { id: 'gr7finance', version: '1' } }).expect(403);
    const ok = (await setGuardrail({ id: 'gr7finance', version: '1', mode: 'converse' }).expect(200)).body;
    expect(ok.guardrail).toMatchObject({ id: 'gr7finance', version: '1', mode: 'converse', enabled: true });
    expect(aws.bedrock.signatures.bad).toBe(0);
    expect(aws.calls(/^bedrock:GET \/guardrails\/gr7finance/).length).toBeGreaterThan(0);
    const ev = await h.s.db('audit_events').where({ action: 'cloud.model-server.guardrail.set' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(ev.detail)).toMatchObject({ after: { id: 'gr7finance', version: '1', mode: 'converse', enabled: true }, exprsnCheckpoints: 'unchanged' });
  });

  it('guardrailConfig: a blocked prompt and a blocked answer are recorded as guardrail decisions', async () => {
    await setGuardrail({ id: 'gr7finance', version: '1', mode: 'converse' }).expect(200);
    const since = Date.now();
    const fine = await chat('Hello, how are you?');
    expect(fine.state).toBe('complete');
    const sent = aws.bedrock.converseCalls.at(-1)!;
    expect(sent.body.guardrailConfig).toEqual({ guardrailIdentifier: 'gr7finance', guardrailVersion: '1', trace: 'enabled', streamProcessingMode: 'sync' });
    // The prompt: the denied topic.
    const blocked = await chat('Give me some stock tips for tomorrow');
    expect(blocked.state).toBe('failed');
    const [d1] = (await providerDecisions(since)).filter((d) => d.checkpoint === 'user-input');
    expect(d1).toMatchObject({ action: 'block', source_kind: 'model-instance' });
    const f1 = JSON.parse(d1!.findings) as { ruleId: string; ruleName: string; detail: string }[];
    expect(f1.map((f) => f.ruleId)).toEqual(['provider:bedrock:topic:investment_advice']);
    expect(f1[0]!.ruleName).toBe('Bedrock Guardrail');
    expect(JSON.parse(d1!.meta)).toMatchObject({ provider: 'bedrock', providerStage: 'prompt', guardrailId: 'gr7finance', guardrailVersion: '1', guardrailMode: 'converse', model: HAIKU });
    // The answer: the content filter on the model's output.
    const out = await chat('Write the plan please');
    expect(out.state).toBe('failed');
    const [d2] = (await providerDecisions(since)).filter((d) => d.checkpoint === 'model-output');
    expect(JSON.parse(d2!.findings).map((f: { ruleId: string; detail: string }) => [f.ruleId, f.detail])).toEqual([['provider:bedrock:content:violence', 'content:violence (severity high)']]);
    // Nothing of the matched text is in the decision's meta.
    expect(d2!.meta).not.toMatch(/attack plan/i);
  });

  it('ApplyGuardrail: the prompt is checked before Converse, the answer after it', async () => {
    await setGuardrail({ id: 'gr7finance', version: '2', mode: 'apply' }).expect(200);
    const since = Date.now();
    const calls = aws.bedrock.converseCalls.length;
    const blocked = await chat('Please mail me at jo@example.com with stock tips');
    expect(blocked.state).toBe('failed');
    expect(aws.bedrock.converseCalls.length).toBe(calls); // never reached the model
    expect(aws.bedrock.applyCalls.at(-1)).toMatchObject({ id: 'gr7finance', version: '2', source: 'INPUT' });
    const [d] = await providerDecisions(since);
    expect(d).toMatchObject({ checkpoint: 'user-input', action: 'block' });
    expect(JSON.parse(d!.findings).map((f: { ruleId: string }) => f.ruleId).sort()).toEqual(['provider:bedrock:pii:email', 'provider:bedrock:topic:investment_advice']);
    expect(JSON.parse(d!.meta)).toMatchObject({ guardrailMode: 'apply', guardrailVersion: '2' });
    // No guardrailConfig in apply mode; the answer goes to ApplyGuardrail as OUTPUT.
    const ok = await chat('Hello again');
    expect(ok.state).toBe('complete');
    expect(aws.bedrock.converseCalls.at(-1)!.body.guardrailConfig).toBeUndefined();
    expect(aws.bedrock.applyCalls.slice(-2).map((c) => c.source)).toEqual(['INPUT', 'OUTPUT']);
    const out = await chat('Write the plan please');
    expect(out.state).toBe('failed');
    expect((await providerDecisions(since)).some((x) => x.checkpoint === 'model-output' && JSON.parse(x.findings)[0].ruleId === 'provider:bedrock:content:violence')).toBe(true);
  });

  it('Exprsn-AI\'s checkpoints run before and after the guardrail, and turning the guardrail off turns none of them off', async () => {
    for (const g of [{ id: 'gr7finance', version: '1', mode: 'converse', enabled: true }, { id: 'gr7finance', version: '1', mode: 'converse', enabled: false }, null]) {
      await setGuardrail(g).expect(200);
      const since = Date.now();
      const calls = aws.bedrock.converseCalls.length;
      // Before: the user-input rule blocks the prompt; Bedrock (and its guardrail) never see it.
      const before = await chat('Tell me about NIGHTSHADE');
      expect(before.state, `user-input rule with guardrail ${JSON.stringify(g)}`).not.toBe('complete');
      expect(aws.bedrock.converseCalls.length).toBe(calls);
      const exprsnIn = (await decisions(since)).filter((d) => d.checkpoint === 'user-input' && d.action === 'block' && JSON.parse(d.findings).some((f: { ruleId: string }) => /exprsn-in/.test(f.ruleId)));
      expect(exprsnIn.length).toBe(1);
      // After: the model-output rule blocks an answer the guardrail let through.
      await chat('Say the codeword');
      expect(aws.bedrock.converseCalls.length).toBe(calls + 1);
      const exprsnOut = (await decisions(since)).filter((d) => d.checkpoint === 'model-output' && d.action === 'block' && JSON.parse(d.findings).some((f: { ruleId: string }) => /exprsn-out/.test(f.ruleId)));
      expect(exprsnOut.length, `model-output rule with guardrail ${JSON.stringify(g)}`).toBe(1);
      // With the guardrail off or removed, nothing is attached and nothing provider-side is recorded.
      if (!g || !g.enabled) {
        expect(aws.bedrock.converseCalls.at(-1)!.body.guardrailConfig).toBeUndefined();
        const plain = await chat('Some stock tips please');
        expect(plain.state).toBe('complete');
        expect(await providerDecisions(since)).toEqual([]);
      }
    }
  });
});
