/*
 * 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of the cloud model backends, against fakes only:
 * `fake-ai-gateway.ts` (the gateway: its token, logs and cache, a gateway-side fallback on demand) passing calls on to
 * the Workers AI, Azure OpenAI, DigitalOcean GenAI and Bedrock fakes. Each backend's inference calls go through the
 * gateway URL with the provider's own credential still on them; a `confidential` turn leaves no prompt in the
 * gateway's logs and is never cached, while an `internal` one may be; and an answer the gateway served from a
 * fallback (another step or model) is refused, so Exprsn-AI's profile fallback decides what serves. Nothing reaches
 * Cloudflare: the gateway's real host is refused by the offline guard.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { aiGatewayAnswerProblem, aiGatewayPath, aiGatewayPolicy, aiGatewayPolicyHeaders, aiGatewaySettingsSchema } from '../src/cloud/ai-gateway.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { withLabel } from '../src/gateway/ai-gateway-hop.js';
import type { BedrockServer } from '../src/gateway/bedrock-server.js';
import type { ChatChunk } from '../src/gateway/ollama.js';
import { OpenAIServer } from '../src/gateway/openai-server.js';
import type { InstanceRow } from '../src/gateway/repo.js';
import { guardedRequest, servicePolicy, ServiceUrlRefused } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { chatTurn, cloudProfile, modelsWorld, type ModelsWorld } from './cloud-models-helpers.js';
import { FakeAiGateway } from './fake-ai-gateway.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzureOpenAI } from './fake-azure-openai.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { FakeDigitalOcean } from './fake-do.js';

const HAIKU = 'anthropic.claude-3-haiku-20240307-v1:0';
const LLAMA = '@cf/meta/llama-3.1-8b-instruct';

describe('AI Gateway: paths, caching and logs by label, fallback answers', () => {
  const s = aiGatewaySettingsSchema.parse({ accountId: '0'.repeat(26), gatewayId: 'exprsn' });

  it('maps each backend\'s inference calls to the gateway and leaves the rest direct', () => {
    expect(aiGatewayPath('workers-ai', 'https://api.cloudflare.com/client/v4/accounts/a/ai', '/v1/chat/completions')).toBe('/workers-ai/v1/chat/completions');
    expect(aiGatewayPath('workers-ai', 'https://api.cloudflare.com/client/v4/accounts/a/ai', '/models/search?per_page=1000')).toBeNull();
    expect(aiGatewayPath('azure', 'https://contoso.openai.azure.com', '/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21')).toBe('/azure-openai/contoso/gpt4o/chat/completions?api-version=2024-10-21');
    expect(aiGatewayPath('digitalocean', 'https://inference.do-ai.run', '/v1/chat/completions')).toBe('/custom-digitalocean/v1/chat/completions');
    expect(aiGatewayPath('digitalocean', 'https://inference.do-ai.run', '/v1/embeddings', { customProvider: 'custom-do' })).toBe('/custom-do/v1/embeddings');
    expect(aiGatewayPath('digitalocean', 'https://inference.do-ai.run', '/v1/models')).toBeNull();
    expect(aiGatewayPath('bedrock', 'https://bedrock-runtime.eu-central-1.amazonaws.com', `/model/${encodeURIComponent(HAIKU)}/converse-stream`, { region: 'eu-central-1' })).toBe(`/aws-bedrock/bedrock-runtime/eu-central-1/model/${encodeURIComponent(HAIKU)}/converse-stream`);
  });

  it('turns caching and logs off above internal by default, and never for restricted', () => {
    expect(aiGatewayPolicy(s, 'public')).toEqual({ cache: true, logs: true });
    expect(aiGatewayPolicy(s, 'internal')).toEqual({ cache: true, logs: true });
    expect(aiGatewayPolicy(s, 'confidential')).toEqual({ cache: false, logs: false });
    expect(aiGatewayPolicy(s, 'restricted')).toEqual({ cache: false, logs: false });
    expect(aiGatewayPolicy(s, null)).toEqual({ cache: false, logs: false }); // a call outside a lease
    const open = aiGatewaySettingsSchema.parse({ accountId: '0'.repeat(26), gatewayId: 'g', cacheTtl: 600, confidential: { cache: true, logs: true } });
    expect(aiGatewayPolicy(open, 'confidential')).toEqual({ cache: true, logs: true });
    expect(aiGatewayPolicy(open, 'restricted')).toEqual({ cache: false, logs: false });
    expect(aiGatewayPolicyHeaders(open, 'internal')).toEqual({ 'cf-aig-collect-log': 'true', 'cf-aig-cache-ttl': '600' });
    expect(aiGatewayPolicyHeaders(s, 'confidential')).toEqual({ 'cf-aig-collect-log': 'false', 'cf-aig-skip-cache': 'true' });
  });

  it('refuses an answer from a gateway-side fallback step or another model', () => {
    const h = (o: Record<string, string>) => (n: string) => o[n] ?? null;
    expect(aiGatewayAnswerProblem(h({}), LLAMA)).toBeNull();
    expect(aiGatewayAnswerProblem(h({ 'cf-aig-step': '0', 'cf-aig-model': LLAMA }), LLAMA)).toBeNull();
    expect(aiGatewayAnswerProblem(h({ 'cf-aig-step': '1' }), LLAMA)).toMatch(/fallback step 1/);
    expect(aiGatewayAnswerProblem(h({ 'cf-aig-model': '@cf/other/model' }), LLAMA)).toMatch(/not .*llama/);
  });

  it('never reaches the real gateway in tests', async () => {
    const err = await guardedRequest({ url: new URL('https://gateway.ai.cloudflare.com/v1/a/g/workers-ai/v1/chat/completions'), method: 'POST', headers: {}, timeoutMs: 1000, check: () => null } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUrlRefused);
    expect(String((err as Error).message)).toMatch(/real cloud host blocked in tests/);
  });
});

describe('AI Gateway in front of each cloud backend', () => {
  let w: ModelsWorld;
  let gw: FakeAiGateway;
  let cf: FakeCloudflare;
  let aoai: FakeAzureOpenAI;
  let dof: FakeDigitalOcean;
  let aws: FakeAws;
  let cfAccount: CloudAccount;
  let awsAccount: CloudAccount;
  let cfToken = '';
  let doKey = '';
  const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
  const awsKey = { accessKeyId: 'ASIAFAKEAIGATEWAY001', secretAccessKey: 'fake-secret-for-gateway-signing', sessionToken: 'fake-session-token' };

  const row = (o: { kind: InstanceRow['kind']; url: string; cloud: Record<string, unknown> }): InstanceRow => ({ id: `inst-${o.kind}-${String(o.cloud.flavour ?? 'bedrock')}`, pool_id: 'p', name: 'x', url: o.url, kind: o.kind, socket_path: null, token_ref: null, token_tenant: null, token_owner: null, tls: null, deploy: 'docker', settings: { cloud: o.cloud as never }, state: 'active', health: 'healthy', health_detail: null, version: null, last_seen_at: null }) as unknown as InstanceRow;
  const gateway = (extra: Record<string, unknown> = {}) => ({ accountId: cfAccount.id, gatewayId: 'exprsn', ...extra });

  async function collect(it: AsyncIterable<ChatChunk>): Promise<string> {
    let text = '';
    for await (const c of it) text += c.message?.content ?? '';
    return text;
  }

  beforeAll(async () => {
    gw = await new FakeAiGateway().start();
    cf = await new FakeCloudflare().start();
    aoai = await new FakeAzureOpenAI().start();
    dof = await new FakeDigitalOcean().start();
    aws = await new FakeAws().start();
    cfToken = cf.addToken(['Workers AI Read', 'AI Gateway Write'], { accountOwned: true }).value;
    aoai.keys.add('azure-key-1');
    aoai.deployments.set('gpt4o-prod', { model: 'gpt-4o', version: '2024-08-06' });
    doKey = dof.genai.addModelKey();
    aws.keys.set(awsKey.accessKeyId, { ...awsKey, arn: `arn:aws:sts::${aws.account}:assumed-role/exprsn-read/s`, status: 'Active', createdAt: Date.now() } as never);
    gw.accountId = cf.accountId;
    gw.gatewayId = 'exprsn';
    gw.tokens.add(cfToken);
    gw.upstream.set('workers-ai', (rest, q) => `${cf.url}/client/v4/accounts/${cf.accountId}/ai${rest}${q}`);
    gw.upstream.set('azure-openai', (rest, q) => {
      const [, , deployment, ...tail] = rest.split('/');
      return `${aoai.url}/openai/deployments/${deployment}/${tail.join('/')}${q}`;
    });
    gw.upstream.set('custom-digitalocean', (rest, q) => `${dof.url}${rest}${q}`);
    gw.upstream.set('aws-bedrock', (rest, q) => `${aws.url}${rest.replace(/^\/bedrock-runtime\/[^/]+/, '')}${q}`);

    w = await modelsWorld();
    cfAccount = await seedAccount(w.h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-gateway', providerIds: { cloudflareAccountId: cf.accountId } });
    awsAccount = await seedAccount(w.h, { provider: 'aws', mode: 'federated', name: 'aws-gateway', providerIds: { awsAccountId: aws.account } });
    w.h.s.cloud.credentials = { for: async (a: CloudAccount) => (a.provider === 'aws' ? { kind: 'aws', ...awsKey, expiresAt: Date.now() + 3_600_000 } : { kind: 'token', token: cfToken, accountId: cf.accountId }) } as never;
    w.h.s.cloud.aiGateway.endpoints = { gateway: `${gw.url}/v1`, api: `${cf.url}/client/v4` };
    w.h.s.cloud.modelCatalogue.endpoints.cloudflareApi = `${cf.url}/client/v4`;
    w.h.s.cloud.bedrock.setEndpoints({ bedrock: aws.url, bedrockRuntime: aws.url });
    w.h.s.cloud.bedrock.setTransport({ sleep: async () => {}, random: () => 0.5 });
  }, 180_000);
  afterAll(async () => {
    await w?.h.close();
    for (const f of [gw, cf, aoai, dof, aws]) await f.stop();
  });
  beforeEach(() => {
    gw.reset();
    cf.reset();
    aoai.reset();
  });

  it('Workers AI: through the gateway URL with the account token; internal is logged and cached, confidential is neither', async () => {
    const r = row({ kind: 'openai', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, cloud: { provider: 'cloudflare', accountId: cfAccount.id, region: 'global', flavour: 'workers-ai', aiGateway: gateway() } });
    const hop = await w.h.s.cloud.aiGateway.hop(r);
    const server = new OpenAIServer(r.url, { timeoutMs: 5000, policy, flavour: 'workers-ai', authHeaders: async () => ({ authorization: `Bearer ${cfToken}` }), aiGateway: async () => hop });
    const ask = (content: string) => server.chat({ model: LLAMA, messages: [{ role: 'user', content }] }, new AbortController().signal);

    expect(await withLabel('internal', () => collect(ask('internal question')))).toMatch(/internal question/);
    const via = gw.calls('aig:workers-ai').at(-1)!;
    expect(via.path).toBe(`/v1/${cf.accountId}/exprsn/workers-ai/v1/chat/completions`);
    expect(via.headers['cf-aig-authorization']).toBe(`Bearer ${cfToken}`);
    expect(via.headers['cf-aig-collect-log']).toBe('true');
    expect(via.headers['cf-aig-skip-cache']).toBeUndefined();
    // The provider still saw its own credential, through the gateway.
    expect(cf.calls(/ai\/v1\/chat\/completions/).at(-1)!.headers.authorization).toBe(`Bearer ${cfToken}`);
    expect(gw.logs.map((l) => l.request).join(' ')).toContain('internal question');
    // The same internal question again: answered from the gateway's cache, not the provider.
    const before = cf.calls(/ai\/v1\/chat\/completions/).length;
    await withLabel('internal', () => collect(ask('internal question')));
    expect(cf.calls(/ai\/v1\/chat\/completions/).length).toBe(before);

    gw.logs.length = 0;
    expect(await withLabel('confidential', () => collect(ask('confidential plan for Q4')))).toMatch(/confidential plan/);
    const conf = gw.calls('aig:workers-ai').at(-1)!;
    expect(conf.headers['cf-aig-collect-log']).toBe('false');
    expect(conf.headers['cf-aig-skip-cache']).toBe('true');
    expect(gw.logs).toEqual([]);
    expect(JSON.stringify(gw.logs)).not.toContain('confidential plan');
    // Again: never served from the cache, always the provider.
    const n = cf.calls(/ai\/v1\/chat\/completions/).length;
    await withLabel('confidential', () => collect(ask('confidential plan for Q4')));
    expect(cf.calls(/ai\/v1\/chat\/completions/).length).toBe(n + 1);
    expect(gw.logs).toEqual([]);
    // Without a lease's label (a poll, an evaluation): as above internal.
    await collect(ask('no label'));
    expect(gw.logs).toEqual([]);
    // Listing models goes straight to Cloudflare, not through the gateway.
    const listed = await server.models();
    expect(listed.length).toBeGreaterThan(0);
    expect(gw.calls(/models/).length).toBe(0);
  });

  it('Azure OpenAI: the deployment path under azure-openai/<resource>, the api-key passed on', async () => {
    const r = row({ kind: 'openai', url: aoai.url, cloud: { provider: 'azure', accountId: cfAccount.id, region: 'westeurope', flavour: 'azure', auth: 'key', aiGateway: gateway() } });
    const hop = await w.h.s.cloud.aiGateway.hop(r);
    const server = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, flavour: 'azure', apiVersion: '2024-06-01', token: async () => 'azure-key-1', aiGateway: async () => hop });
    expect(await withLabel('confidential', () => collect(server.chat({ model: 'gpt4o-prod', messages: [{ role: 'user', content: 'azure secret' }] }, new AbortController().signal)))).toBe('You said: azure secret');
    const via = gw.calls('aig:azure-openai').at(-1)!;
    expect(via.path).toBe(`/v1/${cf.accountId}/exprsn/azure-openai/127/gpt4o-prod/chat/completions`);
    expect(via.query.get('api-version')).toBe('2024-06-01');
    expect(via.headers['api-key']).toBe('azure-key-1');
    expect(aoai.calls('aoai:chat/completions').at(-1)!.headers['api-key']).toBe('azure-key-1');
    expect(gw.logs).toEqual([]);
  });

  it('DigitalOcean GenAI: a custom provider in front of serverless inference, with the model access key', async () => {
    const r = row({ kind: 'openai', url: dof.url, cloud: { provider: 'digitalocean', accountId: cfAccount.id, region: 'tor1', flavour: 'digitalocean', auth: 'key', aiGateway: gateway() } });
    const hop = await w.h.s.cloud.aiGateway.hop(r);
    const server = new OpenAIServer(dof.url, { timeoutMs: 5000, policy, flavour: 'digitalocean', token: async () => doKey, aiGateway: async () => hop });
    const text = await withLabel('internal', () => collect(server.chat({ model: 'llama3.3-70b-instruct', messages: [{ role: 'user', content: 'hello do' }] }, new AbortController().signal)));
    expect(text).toMatch(/hello do/);
    const via = gw.calls('aig:custom-digitalocean').at(-1)!;
    expect(via.path).toBe(`/v1/${cf.accountId}/exprsn/custom-digitalocean/v1/chat/completions`);
    expect(via.headers.authorization).toBe(`Bearer ${doKey}`);
    expect(gw.logs).toHaveLength(1);
  });

  it('Bedrock: ConverseStream signed for the regional endpoint, sent through aws-bedrock, the signature still valid', async () => {
    const r = row({ kind: 'bedrock', url: 'https://bedrock-runtime.eu-central-1.amazonaws.com', cloud: { provider: 'aws', accountId: awsAccount.id, region: 'eu-central-1', aiGateway: gateway() } });
    const server = w.h.s.cloud.bedrock.serverFor(r, () => undefined) as BedrockServer;
    const before = aws.bedrock.signatures.bad;
    const text = await withLabel('confidential', () => collect(server.chat({ model: HAIKU, messages: [{ role: 'user', content: 'bedrock confidential' }] }, new AbortController().signal)));
    expect(text).toBe('You said: bedrock confidential');
    const via = gw.calls('aig:aws-bedrock').at(-1)!;
    expect(via.path).toBe(`/v1/${cf.accountId}/exprsn/aws-bedrock/bedrock-runtime/eu-central-1/model/${encodeURIComponent(HAIKU)}/converse-stream`);
    expect(via.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAFAKEAIGATEWAY001\/\d{8}\/eu-central-1\/bedrock\/aws4_request/);
    expect(via.headers['cf-aig-collect-log']).toBe('false');
    expect(aws.bedrock.signatures.bad).toBe(before);
    expect(gw.logs).toEqual([]);
    // The listing (control plane) is not proxied.
    expect(gw.calls(/foundation-models/).length).toBe(0);
  });

  it('refuses an answer the gateway served from its own fallback, on every backend', async () => {
    gw.fallback = { step: '1', model: '@cf/meta/llama-3.2-1b-instruct' };
    const r = row({ kind: 'openai', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, cloud: { provider: 'cloudflare', accountId: cfAccount.id, region: 'global', flavour: 'workers-ai', aiGateway: gateway() } });
    const hop = await w.h.s.cloud.aiGateway.hop(r);
    const server = new OpenAIServer(r.url, { timeoutMs: 5000, policy, flavour: 'workers-ai', authHeaders: async () => ({ authorization: `Bearer ${cfToken}` }), aiGateway: async () => hop });
    await expect(withLabel('internal', () => collect(server.chat({ model: LLAMA, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal)))).rejects.toThrow(/fallback step 1/);
    const b = w.h.s.cloud.bedrock.serverFor(row({ kind: 'bedrock', url: 'https://bedrock-runtime.eu-central-1.amazonaws.com', cloud: { provider: 'aws', accountId: awsAccount.id, region: 'eu-central-1', aiGateway: gateway() } }), () => undefined);
    await expect(withLabel('internal', () => collect(b.chat({ model: HAIKU, messages: [{ role: 'user', content: 'x' }] }, new AbortController().signal)))).rejects.toThrow(/fallback/);
  });

  it('sets the gateway on an instance by route; a turn goes through it, and the profile\'s fallback serves when the gateway falls back', async () => {
    const { inst } = await cloudProfile(w, { pool: 'cf-gw', instance: { name: 'workers-ai-gw', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, cloud: { flavour: 'workers-ai', accountId: cfAccount.id, region: 'global' } }, serverModel: LLAMA, profile: 'cf-gw-llama' });
    // A second profile on a direct instance (no gateway), as the first one's fallback.
    const direct = await cloudProfile(w, { pool: 'cf-direct', instance: { name: 'workers-ai-direct', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, cloud: { flavour: 'workers-ai', accountId: cfAccount.id, region: 'global' } }, serverModel: '@cf/meta/llama-3.2-1b-instruct', profile: 'cf-direct-small' });
    await w.h.s.db('profiles').where({ name: 'cf-gw-llama' }).update({ fallback: JSON.stringify({ profileId: direct.profileId, afterQueueWaitMs: 60_000 }) });

    await w.admin.agent.put(`/api/admin/instances/${inst.id}/ai-gateway`).set('x-csrf-token', w.admin.csrf).send({ accountId: '0'.repeat(26), gatewayId: 'exprsn' }).expect(409);
    const set = await w.admin.agent.put(`/api/admin/instances/${inst.id}/ai-gateway`).set('x-csrf-token', w.admin.csrf).send({ accountId: cfAccount.id, gatewayId: 'exprsn', cacheTtl: 300 }).expect(200);
    expect(set.body).toMatchObject({ aiGateway: { gatewayId: 'exprsn', cache: true, logs: true, confidential: { cache: false, logs: false } }, policy: { internal: { cache: true, logs: true }, confidential: { cache: false, logs: false }, restricted: { cache: false, logs: false } } });
    expect((await w.h.s.gateway.repo.instance(inst.id))!.settings.cloud!.aiGateway).toMatchObject({ gatewayId: 'exprsn' });
    expect((await w.h.s.audit.list(w.h.tenantId, { action: 'instance.ai_gateway.set' })).length).toBe(1);

    gw.reset();
    const r1 = await chatTurn(w, 'cf-gw-llama', 'Through the gateway');
    expect(r1.state).toBe('complete');
    expect(gw.calls('aig:workers-ai').length).toBe(1);
    expect(gw.calls('aig:workers-ai')[0]!.headers['cf-aig-collect-log']).toBe('true'); // an internal turn
    expect(gw.calls('aig:workers-ai')[0]!.headers['cf-aig-cache-ttl']).toBe('300');

    // The gateway answers from its own fallback: the answer is refused, never used. Chat's loop does not retry a failed
    // call elsewhere (its fallback is for the queue wait), so the turn fails; no usage is recorded for the other model.
    gw.fallback = { step: '1', model: '@cf/other/model' };
    const r2 = await chatTurn(w, 'cf-gw-llama', 'Gateway falls back');
    expect(r2.state).toBe('failed');
    const u2 = await w.h.s.db('usage_records').where({ message_id: r2.sent.messageId });
    expect(u2.some((u: { model: string }) => u.model === '@cf/other/model')).toBe(false);
    // Agent runs and workflow steps (`runFollowing`): Exprsn-AI's profile fallback serves, on the model the profile names.
    const g = w.h.s.gateway;
    const resolved = await g.resolve(w.h.tenantId, 'cf-gw-llama');
    const signal = new AbortController().signal;
    const out = await g.runFollowing(resolved, 'internal', { signal }, (id) => g.resolve(w.h.tenantId, id), async (use, lease) => {
      try {
        let text = '';
        for await (const chunk of lease.client.chat({ model: use.model.name, messages: [{ role: 'user', content: 'who answers?' }] }, signal)) text += chunk.message?.content ?? '';
        return text;
      } finally {
        lease.release(null);
      }
    });
    expect(out.resolved.profile.name).toBe('cf-direct-small');
    expect(out.resolved.model.name).toBe('@cf/meta/llama-3.2-1b-instruct');
    expect(out.failed).toEqual([{ profile: 'cf-gw-llama', error: expect.stringMatching(/fallback step 1/) }]);
    gw.fallback = null;

    await w.admin.agent.delete(`/api/admin/instances/${inst.id}/ai-gateway`).set('x-csrf-token', w.admin.csrf).expect(204);
    expect((await w.h.s.gateway.repo.instance(inst.id))!.settings.cloud!.aiGateway).toBeUndefined();
    gw.reset();
    expect((await chatTurn(w, 'cf-gw-llama', 'Direct again')).state).toBe('complete');
    expect(gw.calls('aig:workers-ai').length).toBe(0);
  });

  it('writes the gateway\'s own settings on the Cloudflare account: rate limits, logs off by default', async () => {
    await localUserCloudAdmin(w);
    const admin = await (await import('./helpers.js')).loginAdmin(w.h, 'cga');
    const res = await admin.agent.put(`/api/admin/cloud/accounts/${cfAccount.id}/ai-gateways/exprsn`).set('x-csrf-token', admin.csrf).send({ rateLimit: { limit: 600, intervalSeconds: 60 } });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ created: true, gateway: 'exprsn', logs: false, cacheTtl: 0, authentication: true });
    const made = cf.basic.get('ai-gateway')!.get('exprsn')!;
    expect(made).toMatchObject({ id: 'exprsn', collect_logs: false, cache_ttl: 0, authentication: true, rate_limiting_limit: 600, rate_limiting_interval: 60, rate_limiting_technique: 'sliding' });
    const again = await admin.agent.put(`/api/admin/cloud/accounts/${cfAccount.id}/ai-gateways/exprsn`).set('x-csrf-token', admin.csrf).send({ cacheTtl: 120 }).expect(200);
    expect(again.body.created).toBe(false);
    expect(cf.basic.get('ai-gateway')!.get('exprsn')).toMatchObject({ cache_ttl: 120, rate_limiting_limit: 0 });
    expect((await w.h.s.audit.list(w.h.tenantId, { action: 'cloud.ai_gateway.created' })).length).toBe(1);
  });
});

async function localUserCloudAdmin(w: ModelsWorld) {
  const { localUser } = await import('./helpers.js');
  await localUser(w.h, 'cga', ['cloud-admin', 'member'], 'confidential');
}
