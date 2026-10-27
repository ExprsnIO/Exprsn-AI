import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { crc32 as zlibCrc } from 'node:zlib';
import { crc32, decodeEventStream, EventStreamDecoder, EventStreamError, EventStreamException, events } from '../src/cloud/aws-event-stream.js';
import { controlEndpoint, profileRegions, runtimeEndpoint } from '../src/cloud/bedrock.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { BedrockServer, toConverseRequest } from '../src/gateway/bedrock-server.js';
import type { ChatChunk } from '../src/gateway/ollama.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws, type FakeAwsKey } from './fake-aws.js';
import { encodeEvent, vectorOf, type ConverseCall } from './fake-aws-bedrock.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 60 (B-10501): Amazon Bedrock as a gateway model server, against the Bedrock fake in
 * `fake-aws.ts` only (EXPRSN_TESTS_OFFLINE refuses the real hosts). Converse and ConverseStream through the gateway
 * (system, tools and tool results, streaming deltas, usage metered like an Ollama turn), Titan and Cohere embeddings,
 * SigV4 with the account's session (verified by the fake), the regional endpoint, the event-stream framing (partial
 * frames, CRC errors, truncation, exceptions mid-stream), and inference profiles refused when a routing region is off
 * the allow-list or the model's label is above the ceiling. Migrations 146 and 159 are applied here when missing
 * (159 is not registered yet).
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const EU_PROFILE = 'eu.anthropic.claude-3-haiku-20240307-v1:0';
const WIDE_PROFILE = 'eu.anthropic.claude-3-haiku-wide-v1:0';
const GLOBAL_PROFILE = 'global.anthropic.claude-3-haiku-20240307-v1:0';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AWS event-stream framing (B-10501)', () => {
  const frames = [encodeEvent({ ':event-type': 'contentBlockDelta', ':message-type': 'event', ':content-type': 'application/json' }, '{"delta":{"text":"Hel"}}'), encodeEvent({ ':event-type': 'contentBlockDelta', ':message-type': 'event' }, '{"delta":{"text":"lo"}}'), encodeEvent({ ':event-type': 'metadata', ':message-type': 'event' }, '{"usage":{"inputTokens":3,"outputTokens":2}}')];
  const all = Buffer.concat(frames);

  it('computes the CRC32 the framing uses', () => {
    const b = Buffer.from('exprsn event stream');
    expect(crc32(b)).toBe(zlibCrc(b) >>> 0);
  });

  it('decodes frames split anywhere: byte by byte, and many frames in one read', async () => {
    const d = new EventStreamDecoder();
    const out = [];
    for (const byte of all) out.push(...d.push(Buffer.from([byte])));
    d.end();
    expect(out.map((m) => m.headers[':event-type'])).toEqual(['contentBlockDelta', 'contentBlockDelta', 'metadata']);
    expect(out[0]!.payload.toString()).toBe('{"delta":{"text":"Hel"}}');
    const whole = new EventStreamDecoder().push(all);
    expect(whole).toHaveLength(3);
    const evs = [];
    for await (const e of events(decodeEventStream((async function* () { yield all.subarray(0, 5); yield all.subarray(5, 40); yield all.subarray(40); })()))) evs.push(e);
    expect(evs.map((e) => e.type)).toEqual(['contentBlockDelta', 'contentBlockDelta', 'metadata']);
    expect(evs[2]!.body).toEqual({ usage: { inputTokens: 3, outputTokens: 2 } });
  });

  it('refuses a CRC mismatch, a stream cut inside a frame, impossible lengths and an oversized frame', async () => {
    const bad = Buffer.from(all);
    bad[20] = bad[20]! ^ 0xff; // inside the first message's headers
    expect(() => new EventStreamDecoder().push(bad)).toThrow(EventStreamError);
    expect(() => new EventStreamDecoder().push(bad)).toThrow(/message failed its CRC/);
    const prelude = Buffer.from(all);
    prelude[2] = prelude[2]! ^ 0x01;
    expect(() => new EventStreamDecoder().push(prelude)).toThrow(/prelude failed its CRC/);
    const cut = new EventStreamDecoder();
    expect(cut.push(all.subarray(0, all.length - 3))).toHaveLength(2);
    expect(() => cut.end()).toThrow(/ended inside a frame/);
    expect(() => new EventStreamDecoder(32).push(all)).toThrow(/over the 32-byte limit/);
    await expect((async () => {
      for await (const _ of decodeEventStream((async function* () { yield all.subarray(0, 30); })())) void _;
    })()).rejects.toMatchObject({ code: 'truncated' });
  });

  it('raises an exception message with the service\'s type and message', async () => {
    const exc = encodeEvent({ ':exception-type': 'throttlingException', ':message-type': 'exception', ':content-type': 'application/json' }, '{"message":"Too many tokens, please wait."}');
    const err = encodeEvent({ ':error-code': 'InternalFailure', ':error-message': 'boom', ':message-type': 'error' }, '');
    const run = async (b: Buffer) => {
      const got: string[] = [];
      for await (const e of events(decodeEventStream((async function* () { yield b; })()))) got.push(e.type);
      return got;
    };
    await expect(run(Buffer.concat([frames[0]!, exc]))).rejects.toMatchObject({ type: 'throttlingException', message: 'Too many tokens, please wait.' });
    await expect(run(err)).rejects.toBeInstanceOf(EventStreamException);
    await expect(run(err)).rejects.toMatchObject({ type: 'InternalFailure', message: 'boom' });
  });
});

describe('Converse mapping (B-10501)', () => {
  it('maps system, user images, tool calls and their results, merges turns and maps options', () => {
    const { body, dropped } = toConverseRequest({
      model: HAIKU,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: 'Answer in English.' },
        { role: 'user', content: 'What is 17 * 23 and 2 + 2?', images: ['iVBORw0KGgo'] },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tooluse_A1', function: { name: 'calculate', arguments: { expression: '17*23' } } }, { function: { name: 'calculate', arguments: { expression: '2+2' } } }] },
        { role: 'tool', tool_name: 'calculate', content: '{"decimal":"391"}' },
        { role: 'tool', tool_name: 'calculate', content: '{"decimal":"4"}' },
        { role: 'user', content: 'Thanks' }
      ],
      tools: [{ type: 'function', function: { name: 'calculate', description: 'Exact arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } } } } }],
      options: { temperature: 0.2, num_predict: 64, top_p: 0.9, stop: '###', num_ctx: 8192, top_k: 40 },
      think: false,
      format: 'json'
    });
    expect(body.system).toEqual([{ text: 'Be brief.' }, { text: 'Answer in English.' }]);
    const msgs = body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[0]!.content).toEqual([{ text: 'What is 17 * 23 and 2 + 2?' }, { image: { format: 'png', source: { bytes: 'iVBORw0KGgo' } } }]);
    expect(msgs[1]!.content).toEqual([{ toolUse: { toolUseId: 'tooluse_A1', name: 'calculate', input: { expression: '17*23' } } }, { toolUse: { toolUseId: 'tooluse_3_1', name: 'calculate', input: { expression: '2+2' } } }]);
    // Both results and the next user text are one user turn, each result paired with its call.
    expect(msgs[2]!.content).toEqual([{ toolResult: { toolUseId: 'tooluse_A1', content: [{ text: '{"decimal":"391"}' }] } }, { toolResult: { toolUseId: 'tooluse_3_1', content: [{ text: '{"decimal":"4"}' }] } }, { text: 'Thanks' }]);
    expect(body.inferenceConfig).toEqual({ temperature: 0.2, maxTokens: 64, topP: 0.9, stopSequences: ['###'] });
    expect(body.toolConfig).toEqual({ tools: [{ toolSpec: { name: 'calculate', description: 'Exact arithmetic', inputSchema: { json: { type: 'object', properties: { expression: { type: 'string' } } } } } }] });
    expect(dropped.sort()).toEqual(['format', 'num_ctx', 'think', 'top_k']);
    // Tool turns without tools on offer still carry a tool configuration (Converse requires one).
    const later = toConverseRequest({ model: HAIKU, messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'calculate', arguments: {} } }] }, { role: 'tool', content: '1' }] });
    expect(later.body.toolConfig).toEqual({ tools: [{ toolSpec: { name: 'calculate', inputSchema: { json: { type: 'object', properties: {} } } } }] });
  });

  it('names the regional endpoints and an inference profile\'s regions', () => {
    expect(runtimeEndpoint('eu-central-1')).toBe('https://bedrock-runtime.eu-central-1.amazonaws.com');
    expect(controlEndpoint('us-west-2')).toBe('https://bedrock.us-west-2.amazonaws.com');
    expect(profileRegions({ inferenceProfileId: EU_PROFILE, models: [{ modelArn: `arn:aws:bedrock:eu-west-1::foundation-model/${HAIKU}` }, { modelArn: `arn:aws:bedrock:eu-central-1::foundation-model/${HAIKU}` }] })).toEqual(['eu-central-1', 'eu-west-1']);
    expect(profileRegions({ inferenceProfileId: GLOBAL_PROFILE, models: [] })).toEqual(['*']);
  });
});

describe('Bedrock through the gateway (B-10501)', () => {
  let h: Harness;
  const aws = new FakeAws();
  let key: FakeAwsKey;
  let account: CloudAccount;
  let a: Client;
  let b: Client;
  const purposes: string[] = [];
  let secret: string | null = null;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

  const reply = (c: ConverseCall) => {
    const msgs = c.body.messages ?? [];
    const last = msgs[msgs.length - 1]!;
    const result = last.content.find((x) => x.toolResult) as { toolResult: { content: { text: string }[] } } | undefined;
    if (result) return { text: `It is ${(JSON.parse(result.toolResult.content[0]!.text) as { decimal: string }).decimal}.` };
    const text = String(last.content.find((x) => typeof x.text === 'string')?.text ?? '');
    if (c.body.toolConfig?.tools.some((t) => t.toolSpec.name === 'calculate') && /17/.test(text)) return { toolUse: { name: 'calculate', input: { expression: '17 * 23' } } };
    return { text: 'ready and waiting' };
  };

  const server = () => new BedrockServer(h.s.cloud.bedrock.backend(account.id, 'eu-central-1'));
  const collect = async (it: AsyncIterable<ChatChunk>) => {
    const out: ChatChunk[] = [];
    for await (const c of it) out.push(c);
    return out;
  };

  beforeAll(async () => {
    await aws.start();
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_model_entries'))) await (await import('../src/db/migrations/159_cloud_models.js')).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.modelImport.resetSchemaCache();
    // A federated session's key: the fake checks the session token on every call.
    key = { accessKeyId: 'ASIAFAKEBEDROCK0001', secretAccessKey: 'fake-secret-for-bedrock-signing', sessionToken: 'fake-session-token', arn: `arn:aws:sts::${aws.account}:assumed-role/exprsn-read/s`, status: 'Active', createdAt: Date.now() };
    aws.keys.set(key.accessKeyId, key);
    (h.s.cloud as { credentials: unknown }).credentials = {
      for: async (_a: CloudAccount, purpose: string) => {
        purposes.push(purpose);
        return { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: secret ?? key.secretAccessKey, sessionToken: key.sessionToken, expiresAt: Date.now() + 3_600_000 };
      }
    };
    account = await seedAccount(h, { provider: 'aws', mode: 'federated', name: 'aws-models', providerIds: { awsAccountId: aws.account } });
    await h.s.db('cloud_account_regions').insert({ account_id: account.id, region: 'eu-west-1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: false, updated_at: Date.now() });
    account = (await h.s.cloud.accounts.get(account.id))!;
    h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
    aws.bedrock.reply = reply;
    await localUser(h, 'bma', ['model-admin', 'tenant-admin', 'cloud-operator'], 'confidential');
    await localUser(h, 'bmb', ['model-admin'], 'confidential');
    a = await loginAdmin(h, 'bma');
    b = await loginAdmin(h, 'bmb');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await aws.stop();
  });

  beforeEach(() => {
    aws.bedrock.reply = reply;
    secret = null;
  });

  let instanceId = '';
  let poolId = '';

  it('registers a Bedrock instance for an account and region, refusing a pool above the region\'s ceiling', async () => {
    const high = (await post(a, '/api/admin/pools', { name: 'bedrock-conf', accelerator: 'cpu', labelCeiling: 'confidential' }).expect(201)).body;
    const refused = await post(a, `/api/admin/pools/${high.id}/instances`, { name: 'br-conf', kind: 'bedrock', deploy: 'docker', cloud: { accountId: account.id, region: 'eu-central-1' } }).expect(403);
    expect(refused.body).toMatchObject({ step: 'zone', region: 'eu-central-1', ceiling: 'internal' });
    await post(a, `/api/admin/pools/${high.id}/instances`, { name: 'br-x', kind: 'bedrock', deploy: 'docker' }).expect(400); // no account
    const pool = (await post(a, '/api/admin/pools', { name: 'bedrock-eu', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    poolId = pool.id;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'br-off', kind: 'bedrock', deploy: 'docker', cloud: { accountId: account.id, region: 'us-east-1' } }).expect(403); // off the allow-list
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'br-tok', kind: 'bedrock', deploy: 'docker', token: 'x', cloud: { accountId: account.id, region: 'eu-central-1' } }).expect(400);
    const inst = (await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'bedrock-eu-central-1', kind: 'bedrock', deploy: 'docker', cloud: { accountId: account.id, region: 'eu-central-1' } }).expect(201)).body;
    instanceId = inst.id;
    expect(inst).toMatchObject({ kind: 'bedrock', url: 'https://bedrock-runtime.eu-central-1.amazonaws.com', health: 'healthy', version: 'bedrock eu-central-1', supports: { load: false, unload: false, pull: false, embed: true } });
    expect(inst.settings.cloud).toEqual({ provider: 'aws', accountId: account.id, region: 'eu-central-1' });
    expect(inst.available.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining([HAIKU, 'amazon.titan-embed-text-v2:0', 'cohere.embed-english-v3', EU_PROFILE]));
    // SigV4 with the session: the read purpose, the session token, the region and service in the scope, verified by the fake.
    const listed = aws.calls(/^bedrock:GET \/foundation-models/);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAFAKEBEDROCK0001\/\d{8}\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=[^,]*x-amz-security-token/);
    expect(listed[0]!.headers['x-amz-security-token']).toBe('fake-session-token');
    expect(new Set(purposes)).toEqual(new Set(['read']));
    expect(aws.bedrock.signatures.bad).toBe(0);
  });

  it('imports, evaluates and approves Claude on Bedrock, then streams a conversation that calls a read-only tool and is metered like an Ollama turn', async () => {
    const imp = (await post(a, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: [HAIKU] }).expect(201)).body;
    expect(imp.results).toEqual([expect.objectContaining({ id: HAIKU, outcome: 'registered', ceiling: 'internal', label: 'internal', accessState: 'granted', instance: 'bedrock-eu-central-1' })]);
    const modelId = imp.results[0].modelId as string;
    const listed = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === modelId);
    expect(listed).toMatchObject({ name: HAIKU, format: 'server', held: true, state: 'draft', serverInstanceId: instanceId, importState: 'pulled' });
    expect(listed.pools).toEqual([expect.objectContaining({ pool: 'bedrock-eu', residency: 'warm' })]);
    await post(a, `/api/admin/models/${modelId}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    const ev = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === modelId);
    expect(ev.state).toBe('evaluated');
    expect(ev.evaluation).toMatchObject({ instance: 'bedrock-eu-central-1', passed: 2, total: 2 });
    expect(ev.capabilities).toEqual(expect.arrayContaining(['completion', 'tools']));
    await post(a, `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(403); // dual control
    await post(b, `/api/admin/models/${modelId}/lifecycle`, { to: 'approved' }).expect(200);

    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'BEDROCK0000000000000000001', tenant_id: h.tenantId, name: 'claude-eu', display_name: 'Claude on Bedrock (EU)', description: null, alias_of: null, model_id: modelId, pool_id: poolId, num_ctx: 4096, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: ['calculate'], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    await localUser(h, 'bmem', ['member'], 'internal');
    const m = await login(h, 'bmem');
    aws.bedrock.converseCalls.length = 0;
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'What is 17 times 23?', profile: 'claude-eu' }).expect(202);
    let msg: { state: string } | undefined;
    for (let i = 0; i < 400; i++) {
      msg = await h.s.db('messages').where({ id: sent.body.messageId }).first();
      if (msg && ['complete', 'failed'].includes(msg.state)) break;
      await sleep(25);
    }
    expect(msg!.state).toBe('complete');
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toBe('It is 391.');
    expect(view.messages[1].tools).toEqual([expect.objectContaining({ name: 'calculate', expression: '17 * 23' })]);
    // Two ConverseStream rounds: the tool call, then its result paired with Bedrock's own toolUseId.
    const calls = aws.bedrock.converseCalls.filter((c) => c.modelId === HAIKU);
    expect(calls.map((c) => c.op)).toEqual(['ConverseStream', 'ConverseStream']);
    expect(calls[0]!.body.system?.some((s) => s.text.includes('Be brief.'))).toBe(true);
    expect(calls[0]!.body.toolConfig?.tools.map((x) => x.toolSpec.name)).toContain('calculate');
    expect(calls[0]!.body.inferenceConfig).toMatchObject({ temperature: 0.2 });
    const second = calls[1]!.body.messages!;
    expect(second.find((x) => x.role === 'assistant')!.content).toEqual([{ toolUse: { toolUseId: 'tooluse_FAKE0001', name: 'calculate', input: { expression: '17 * 23' } } }]);
    expect(second[second.length - 1]!.content[0]).toMatchObject({ toolResult: { toolUseId: 'tooluse_FAKE0001' } });
    expect(calls.every((c) => c.sessionToken === 'fake-session-token' && c.region === 'eu-central-1')).toBe(true);
    // Metered like an Ollama turn: one chat record with the model's token counts.
    const usage = await h.s.db('usage_records').where({ message_id: sent.body.messageId });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'chat', model: HAIKU });
    expect(Number(usage[0].prompt_tokens)).toBeGreaterThan(0);
    expect(Number(usage[0].output_tokens)).toBeGreaterThan(0);
    // num_ctx has no Converse equivalent: dropped and noted once.
    const dropped = await h.s.db('model_events').where({ event: 'dropped', model: HAIKU });
    expect(dropped.some((e: { reason: string }) => /num_ctx/.test(e.reason))).toBe(true);
    expect(aws.bedrock.signatures.bad).toBe(0);
  });

  it('streams text deltas as they arrive, with thinking and the provider\'s usage', async () => {
    aws.bedrock.reply = () => ({ text: 'One two three four.', reasoning: 'Counting.' });
    const chunks = await collect(server().chat({ model: HAIKU, messages: [{ role: 'user', content: 'Count' }] }, new AbortController().signal));
    expect(chunks.filter((c) => !c.done).map((c) => c.message?.content)).toEqual(['', 'One ', 'two ', 'three ', 'four.']);
    expect(chunks[0]!.message?.thinking).toBe('Counting.');
    const done = chunks.at(-1)!;
    const last = aws.bedrock.converseCalls.at(-1)!;
    expect(done).toMatchObject({ done: true, done_reason: 'stop', eval_count: Math.ceil('One two three four.'.length / 4) });
    expect(done.prompt_eval_count).toBe(11 + (JSON.stringify(last.body.messages).length % 50));
    aws.bedrock.reply = () => ({ text: 'cut', stopReason: 'max_tokens' });
    expect((await collect(server().chat({ model: HAIKU, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).at(-1)!.done_reason).toBe('length');
  });

  it('uses Converse for a model that streams no tool use, and keeps using it', async () => {
    aws.bedrock.models.push({ modelId: 'cohere.command-r-v1:0', providerName: 'Cohere', noStreamTools: true });
    try {
      aws.bedrock.reply = () => ({ toolUse: { name: 'calculate', input: { expression: '2+2' } } });
      const s = server();
      const tools = [{ type: 'function', function: { name: 'calculate', parameters: { type: 'object' } } }];
      aws.bedrock.converseCalls.length = 0;
      const out = await collect(s.chat({ model: 'cohere.command-r-v1:0', messages: [{ role: 'user', content: 'add' }], tools }, new AbortController().signal));
      expect(out.find((c) => c.message?.tool_calls)?.message?.tool_calls).toEqual([{ id: 'tooluse_FAKE0001', function: { name: 'calculate', arguments: { expression: '2+2' } } }]);
      expect(out.at(-1)).toMatchObject({ done: true, prompt_eval_count: expect.any(Number) });
      await collect(s.chat({ model: 'cohere.command-r-v1:0', messages: [{ role: 'user', content: 'again' }], tools }, new AbortController().signal));
      expect(aws.bedrock.converseCalls.map((c) => c.op)).toEqual(['ConverseStream', 'Converse', 'Converse']);
    } finally {
      aws.bedrock.models.pop();
    }
  });

  it('fails a stream on an exception mid-stream with the provider\'s status, and on a bad signature', async () => {
    aws.bedrock.reply = () => ({ text: 'partial answer here' });
    aws.bedrock.streamFailure = { type: 'throttlingException', message: 'Too many tokens, please wait before trying again.' };
    await expect(collect(server().chat({ model: HAIKU, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 429, message: 'Too many tokens, please wait before trying again.' });
    secret = 'not-the-secret';
    const bad = aws.bedrock.signatures.bad;
    await expect(collect(server().chat({ model: HAIKU, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 403 });
    expect(aws.bedrock.signatures.bad).toBeGreaterThan(bad);
  });

  it('embeds with Titan and Cohere through InvokeModel, through the gateway', async () => {
    const badBefore = aws.bedrock.signatures.bad;
    const imp = (await post(a, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: ['amazon.titan-embed-text-v2:0', 'cohere.embed-english-v3'] }).expect(201)).body;
    for (const r of imp.results) {
      expect(r).toMatchObject({ outcome: 'registered', kind: 'embedding' });
      await h.s.gateway.repo.updateModel(r.modelId, { state: 'approved' });
    }
    const texts = ['first passage', 'second passage', 'third'];
    const titan = await h.s.gateway.embed('amazon.titan-embed-text-v2:0', texts, 'internal');
    expect(titan.embeddings).toEqual(texts.map(vectorOf));
    expect(titan.promptTokens).toBe(texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0));
    expect(titan.poolId).toBe(poolId);
    const cohere = await h.s.gateway.embed('cohere.embed-english-v3', texts, 'internal');
    expect(cohere.embeddings).toEqual(texts.map(vectorOf));
    expect(aws.bedrock.invokeCalls.filter((c) => c.modelId === 'amazon.titan-embed-text-v2:0')).toHaveLength(3); // one text per call
    expect(aws.bedrock.invokeCalls.filter((c) => c.modelId === 'cohere.embed-english-v3').map((c) => c.body)).toEqual([{ texts, input_type: 'search_document', truncate: 'END' }]);
    const invoke = aws.calls(/^bedrock:POST \/model\/amazon\.titan-embed-text-v2%3A0\/invoke$/);
    expect(invoke.length).toBe(3); // the model id's colon is encoded on the wire, and the signature still verifies
    expect(aws.bedrock.signatures.bad).toBe(badBefore);
  });

  it('calls the regional endpoints, which tests refuse when no fake is named', async () => {
    h.s.cloud.bedrock.setEndpoints({});
    try {
      await expect(h.s.cloud.bedrock.backend(account.id, 'eu-west-1').offers()).rejects.toThrow(/real cloud host blocked in tests: bedrock\.eu-west-1\.amazonaws\.com/);
      await expect(collect(new BedrockServer(h.s.cloud.bedrock.backend(account.id, 'eu-central-1')).chat({ model: HAIKU, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toThrow(/bedrock-runtime\.eu-central-1\.amazonaws\.com/);
    } finally {
      h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    }
  });

  it('refuses inference profiles that route off the allow-list or above the ceiling, at import, approval and call time', async () => {
    const imp = (await post(a, `/api/admin/cloud/accounts/${account.id}/model-import`, { region: 'eu-central-1', ids: [EU_PROFILE, WIDE_PROFILE, GLOBAL_PROFILE] }).expect(201)).body;
    const by = Object.fromEntries(imp.results.map((r: { id: string }) => [r.id, r]));
    expect(by[WIDE_PROFILE]).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/eu-west-3, which is not on aws-models's allow-list/) });
    expect(by[GLOBAL_PROFILE]).toMatchObject({ outcome: 'skipped', reason: expect.stringMatching(/global profile/) });
    expect(by[EU_PROFILE]).toMatchObject({ outcome: 'registered', ceiling: 'internal' });
    const entry = (await a.agent.get(`/api/admin/cloud/model-entries?account=${account.id}`).expect(200)).body.entries.find((e: { externalId: string }) => e.externalId === EU_PROFILE);
    expect(entry).toMatchObject({ offer: 'inference_profile', region: 'eu-central-1', routesTo: ['eu-central-1', 'eu-west-1'], ceiling: 'internal' });

    // At call time, with no catalogue entry: the wide and global profiles are refused before any model call.
    const before = aws.bedrock.converseCalls.length;
    await expect(collect(server().chat({ model: WIDE_PROFILE, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/eu-west-3/) });
    await expect(collect(server().chat({ model: GLOBAL_PROFILE, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/global inference profile/) });
    expect(aws.bedrock.converseCalls.length).toBe(before);

    // Above the ceiling: raising eu-central-1 to confidential leaves eu-west-1 at internal, so the entry stays internal.
    await h.s.db('cloud_account_regions').where({ account_id: account.id, region: 'eu-central-1' }).update({ ceiling: 'confidential' });
    const id = by[EU_PROFILE].modelId as string;
    expect((await a.agent.patch(`/api/admin/models/${id}`).set('x-csrf-token', a.csrf).send({ label: 'confidential' }).expect(403)).body).toMatchObject({ step: 'zone', ceiling: 'internal' });
    await h.s.gateway.repo.updateModel(id, { label: 'confidential', state: 'evaluated', evaluation: { at: Date.now(), instance: 'x', tests: [], passed: 1, total: 1, toolsWithheld: false } });
    expect((await post(b, `/api/admin/models/${id}/lifecycle`, { to: 'approved' }).expect(403)).body.step).toBe('zone');
    // And at call time: a model labelled above its entry's ceiling is refused by the server's guard.
    await expect(collect(server().chat({ model: EU_PROFILE, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 403 });
    // Back within the ceiling, it is served (and approved).
    await h.s.gateway.repo.updateModel(id, { label: 'internal' });
    await post(b, `/api/admin/models/${id}/lifecycle`, { to: 'approved' }).expect(200);
    const ok = await collect(server().chat({ model: EU_PROFILE, messages: [{ role: 'user', content: 'hello' }] }, new AbortController().signal));
    expect(ok.map((c) => c.message?.content).join('')).toBe('ready and waiting');
    // A routing region removed from the allow-list refuses the profile again.
    await h.s.db('cloud_account_regions').where({ account_id: account.id, region: 'eu-west-1' }).delete();
    await expect(collect(server().chat({ model: EU_PROFILE, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal))).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/eu-west-1/) });
    await h.s.db('cloud_account_regions').insert({ account_id: account.id, region: 'eu-west-1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: false, updated_at: Date.now() });
    await h.s.db('cloud_account_regions').where({ account_id: account.id, region: 'eu-central-1' }).update({ ceiling: 'internal' });
  });
});
