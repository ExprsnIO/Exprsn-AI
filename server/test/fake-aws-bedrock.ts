/*
 * 1.9.99-final, Sprint 60 (B-10501, B-10504): Amazon Bedrock inside the AWS fake (`fake-aws.ts` routes every request
 * whose SigV4 scope names the service `bedrock` here). Control plane: `ListFoundationModels`, `ListInferenceProfiles`
 * (paged), `GetFoundationModelAvailability` (model access per model). Runtime: `Converse`, `ConverseStream` (the AWS
 * event-stream framing, encoded here with its own CRC32 from `node:zlib`, sent in pieces), `InvokeModel` for Titan
 * and Cohere embeddings. Every call's SigV4 signature is verified (the non-S3 canonical URI: the wire path encoded
 * again) against the key's secret, so a signing mistake fails here as it would at AWS. It is never the real Bedrock.
 */
import { createHash, createHmac } from 'node:crypto';
import { crc32 } from 'node:zlib';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

export interface FakeFoundationModel {
  modelId: string;
  providerName: string;
  modelName?: string;
  input?: string[];
  output?: string[];
  inferenceTypes?: string[];
  streaming?: boolean;
  /** Model access: `granted` (default), `pending`, `none`. */
  access?: 'granted' | 'pending' | 'none';
  /** Regions where the model is offered (default every region). */
  regions?: string[];
  /** ConverseStream refuses tool use for this model (Converse still works). */
  noStreamTools?: boolean;
}

export interface FakeProfile {
  id: string;
  name?: string;
  modelId: string;
  regions: string[];
  /** The region whose listing shows it (default the first of `regions`). */
  home?: string;
}

export interface FakeReply {
  text?: string;
  reasoning?: string;
  toolUse?: { name: string; input: Record<string, unknown> };
  stopReason?: string;
}

/**
 * Sprint 61 (B-10506): a Bedrock Guardrail the fake applies: a denied topic (by a pattern), a content filter category
 * and a PII type, each on the prompt (`INPUT`) or the answer (`OUTPUT`). Matched text is never echoed back.
 */
export interface FakeGuardrail {
  id: string;
  name: string;
  versions: string[];
  status?: string;
  /** Words that trip the denied topic `Investment advice`. */
  topic?: RegExp;
  /** Words that trip the content filter `VIOLENCE` (confidence HIGH). */
  violence?: RegExp;
  /** An e-mail address trips the PII entity EMAIL (action BLOCKED). */
  email?: boolean;
  blockedInput?: string;
  blockedOutput?: string;
}

export interface ConverseCall {
  op: 'Converse' | 'ConverseStream';
  modelId: string;
  region: string;
  body: { messages?: { role: string; content: Record<string, unknown>[] }[]; system?: { text: string }[]; toolConfig?: { tools: { toolSpec: { name: string } }[] }; inferenceConfig?: Record<string, unknown>; guardrailConfig?: { guardrailIdentifier?: string; guardrailVersion?: string; trace?: string; streamProcessingMode?: string } };
  sessionToken: string | null;
}

const rfc3986 = (x: string) => encodeURIComponent(x).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const sha256 = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();

/** One event-stream message (prelude, headers as strings, payload, CRCs). */
export function encodeEvent(headers: Record<string, string>, payload: Buffer | string): Buffer {
  const hs = Buffer.concat(
    Object.entries(headers).map(([k, v]) => {
      const name = Buffer.from(k, 'utf8');
      const value = Buffer.from(v, 'utf8');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(value.length);
      return Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), len, value]);
    })
  );
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const total = 12 + hs.length + body.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(hs.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)) >>> 0, 8);
  const msg = Buffer.concat([prelude, hs, body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(msg) >>> 0);
  return Buffer.concat([msg, crc]);
}

const event = (type: string, body: unknown) => encodeEvent({ ':event-type': type, ':content-type': 'application/json', ':message-type': 'event' }, JSON.stringify(body));
const exception = (type: string, message: string) => encodeEvent({ ':exception-type': type, ':content-type': 'application/json', ':message-type': 'exception' }, JSON.stringify({ message }));

const err = (status: number, type: string, message: string): Reply => ({ status, headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`, 'x-amzn-requestid': 'req-bedrock' }, body: { message } });

/** A deterministic vector for a text (8 dimensions). */
export const vectorOf = (text: string): number[] => {
  const h = createHash('sha256').update(text).digest();
  return [...h.subarray(0, 8)].map((b) => Math.round((b / 255) * 1000) / 1000);
};

export class FakeBedrock {
  readonly models: FakeFoundationModel[] = [
    { modelId: 'anthropic.claude-3-haiku-20240307-v1:0', providerName: 'Anthropic', modelName: 'Claude 3 Haiku', input: ['TEXT', 'IMAGE'], output: ['TEXT'] },
    { modelId: 'meta.llama3-8b-instruct-v1:0', providerName: 'Meta', modelName: 'Llama 3 8B Instruct', access: 'none' },
    { modelId: 'mistral.mistral-large-2402-v1:0', providerName: 'Mistral AI', modelName: 'Mistral Large', access: 'pending' },
    { modelId: 'amazon.titan-embed-text-v2:0', providerName: 'Amazon', modelName: 'Titan Text Embeddings V2', output: ['EMBEDDING'], streaming: false },
    { modelId: 'cohere.embed-english-v3', providerName: 'Cohere', modelName: 'Embed English', output: ['EMBEDDING'], streaming: false },
    { modelId: 'amazon.titan-image-generator-v2:0', providerName: 'Amazon', modelName: 'Titan Image Generator', output: ['IMAGE'], streaming: false }
  ];
  readonly profiles: FakeProfile[] = [
    { id: 'eu.anthropic.claude-3-haiku-20240307-v1:0', name: 'EU Claude 3 Haiku', modelId: 'anthropic.claude-3-haiku-20240307-v1:0', regions: ['eu-central-1', 'eu-west-1'] },
    { id: 'eu.anthropic.claude-3-haiku-wide-v1:0', name: 'EU Claude 3 Haiku (wide)', modelId: 'anthropic.claude-3-haiku-20240307-v1:0', regions: ['eu-central-1', 'eu-west-1', 'eu-west-3'], home: 'eu-central-1' },
    { id: 'global.anthropic.claude-3-haiku-20240307-v1:0', name: 'Global Claude 3 Haiku', modelId: 'anthropic.claude-3-haiku-20240307-v1:0', regions: ['eu-central-1', 'us-east-1', 'ap-northeast-1'], home: 'eu-central-1' }
  ];
  /** What a model answers (default: an echo of the last user text). */
  reply: (call: ConverseCall) => FakeReply = (c) => {
    const last = [...(c.body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const text = String((last?.content ?? []).find((b) => typeof b.text === 'string')?.text ?? '');
    return { text: `You said: ${text}` };
  };
  /** Bytes per piece of a streamed answer (small, so frames split across reads). */
  pieceBytes = 7;
  /** Injected into the next stream after its first text delta: an exception message (`throttlingException`...). */
  streamFailure: { type: string; message: string } | null = null;
  /** Profile listing page size (paged with nextToken). */
  profilePage = 2;
  /** Sprint 61 (B-10506): the account's guardrails, by id. */
  readonly guardrails = new Map<string, FakeGuardrail>();
  /** ApplyGuardrail calls (source and the guardrail; never the text kept elsewhere). */
  readonly applyCalls: { id: string; version: string; source: string; text: string }[] = [];
  /** Sprint 61 (B-10505): prompt-cache reads and writes the next answers report (Converse's usage). */
  cacheTokens: { read: number; write: number } | null = null;
  readonly converseCalls: ConverseCall[] = [];
  readonly invokeCalls: { modelId: string; region: string; body: Record<string, unknown> }[] = [];
  /** Signatures verified and refused. */
  readonly signatures = { ok: 0, bad: 0 };

  constructor(private readonly secretOf: (accessKeyId: string) => string | null) {}

  /** The SigV4 check, recomputed from the raw request. */
  private verify(r: RecordedRequest): boolean {
    const auth = r.headers.authorization ?? '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return false;
    const [, keyId, day, region, service, signedHeaders, signature] = m as unknown as string[];
    const secret = this.secretOf(keyId!);
    if (!secret) return false;
    const canonicalUri = r.path.split('/').map((s) => rfc3986(s)).join('/');
    const query = [...r.query.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
    const names = signedHeaders!.split(';');
    const canonicalHeaders = names.map((n) => `${n}:${(r.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
    const payload = sha256(r.raw ?? Buffer.from(r.body));
    if ((r.headers['x-amz-content-sha256'] ?? payload) !== payload) return false;
    const canonical = [r.method, canonicalUri, query, canonicalHeaders, signedHeaders, payload].join('\n');
    const scope = `${day}/${region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', r.headers['x-amz-date'] ?? '', scope, sha256(canonical)].join('\n');
    const k = hmac(hmac(hmac(hmac(`AWS4${secret}`, day!), region!), service!), 'aws4_request');
    return createHmac('sha256', k).update(toSign).digest('hex') === signature;
  }

  /** What a guardrail finds in a text: its assessment (no matched text) and whether it intervenes. */
  assess(g: FakeGuardrail, text: string): { intervened: boolean; assessment: Record<string, unknown> } {
    const a: Record<string, unknown> = {};
    let hit = false;
    if (g.topic) {
      const t = g.topic.test(text);
      a.topicPolicy = { topics: [{ name: 'Investment advice', type: 'DENY', action: t ? 'BLOCKED' : 'NONE' }] };
      hit ||= t;
    }
    if (g.violence) {
      const v = g.violence.test(text);
      a.contentPolicy = { filters: [{ type: 'VIOLENCE', confidence: v ? 'HIGH' : 'NONE', filterStrength: 'HIGH', action: v ? 'BLOCKED' : 'NONE' }] };
      hit ||= v;
    }
    if (g.email && /[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) {
      a.sensitiveInformationPolicy = { piiEntities: [{ type: 'EMAIL', action: 'BLOCKED' }] };
      hit = true;
    }
    return { intervened: hit, assessment: a };
  }

  private guardrail(id: string, version: string): FakeGuardrail | null {
    const g = this.guardrails.get(id) ?? [...this.guardrails.values()].find((x) => id.endsWith(`:guardrail/${x.id}`));
    return g && (version === 'DRAFT' || g.versions.includes(version)) ? g : null;
  }

  private offered(region: string) {
    return this.models.filter((m) => !m.regions || m.regions.includes(region));
  }

  handle(r: RecordedRequest, region: string): Reply {
    if (!this.verify(r)) {
      this.signatures.bad += 1;
      return err(403, 'InvalidSignatureException', 'The request signature we calculated does not match the signature you provided.');
    }
    this.signatures.ok += 1;
    const token = r.headers['x-amz-security-token'] ?? null;
    if (r.method === 'GET' && r.path === '/foundation-models') {
      return {
        status: 200,
        body: {
          modelSummaries: this.offered(region).map((m) => ({ modelArn: `arn:aws:bedrock:${region}::foundation-model/${m.modelId}`, modelId: m.modelId, modelName: m.modelName ?? m.modelId, providerName: m.providerName, inputModalities: m.input ?? ['TEXT'], outputModalities: m.output ?? ['TEXT'], responseStreamingSupported: m.streaming !== false, inferenceTypesSupported: m.inferenceTypes ?? ['ON_DEMAND'], modelLifecycle: { status: 'ACTIVE' } }))
        }
      };
    }
    if (r.method === 'GET' && r.path === '/inference-profiles') {
      const all = this.profiles.filter((p) => (p.home ?? p.regions[0]) === region || p.regions.includes(region));
      const offset = Number(r.query.get('nextToken') ?? 0) || 0;
      const page = all.slice(offset, offset + this.profilePage);
      const next = offset + this.profilePage < all.length ? String(offset + this.profilePage) : undefined;
      return { status: 200, body: { inferenceProfileSummaries: page.map((p) => ({ inferenceProfileId: p.id, inferenceProfileName: p.name ?? p.id, inferenceProfileArn: `arn:aws:bedrock:${region}:123456789012:inference-profile/${p.id}`, status: 'ACTIVE', type: 'SYSTEM_DEFINED', models: p.regions.map((x) => ({ modelArn: `arn:aws:bedrock:${x}::foundation-model/${p.modelId}` })) })), ...(next ? { nextToken: next } : {}) } };
    }
    const avail = /^\/foundation-model-availability\/([^/]+)$/.exec(r.path);
    if (r.method === 'GET' && avail) {
      const id = decodeURIComponent(avail[1]!);
      const m = this.offered(region).find((x) => x.modelId === id);
      if (!m) return err(404, 'ResourceNotFoundException', `Model ${id} not found`);
      const a = m.access ?? 'granted';
      return { status: 200, body: { modelId: id, agreementAvailability: { status: a === 'pending' ? 'PENDING' : a === 'granted' ? 'AVAILABLE' : 'NOT_AVAILABLE' }, authorizationStatus: a === 'granted' ? 'AUTHORIZED' : 'NOT_AUTHORIZED', entitlementAvailability: a === 'granted' ? 'AVAILABLE' : 'NOT_AVAILABLE', regionAvailability: 'AVAILABLE' } };
    }
    const getGr = /^\/guardrails\/([^/]+)$/.exec(r.path);
    if (r.method === 'GET' && getGr) {
      const id = decodeURIComponent(getGr[1]!);
      const version = r.query.get('guardrailVersion') ?? 'DRAFT';
      const g = this.guardrail(id, version);
      if (!g) return err(404, 'ResourceNotFoundException', `Guardrail ${id} version ${version} not found`);
      return { status: 200, body: { guardrailId: g.id, guardrailArn: `arn:aws:bedrock:${region}:123456789012:guardrail/${g.id}`, name: g.name, version, status: g.status ?? 'READY' } };
    }
    const apply = /^\/guardrail\/([^/]+)\/version\/([^/]+)\/apply$/.exec(r.path);
    if (r.method === 'POST' && apply) {
      const id = decodeURIComponent(apply[1]!);
      const version = decodeURIComponent(apply[2]!);
      const g = this.guardrail(id, version);
      if (!g) return err(404, 'ResourceNotFoundException', `Guardrail ${id} version ${version} not found`);
      let body: { source?: string; content?: { text?: { text?: string } }[] };
      try {
        body = JSON.parse(r.body) as typeof body;
      } catch {
        return err(400, 'ValidationException', 'Malformed input request');
      }
      if (body.source !== 'INPUT' && body.source !== 'OUTPUT') return err(400, 'ValidationException', 'source must be INPUT or OUTPUT');
      const text = (body.content ?? []).map((c) => c.text?.text ?? '').join('\n');
      this.applyCalls.push({ id: g.id, version, source: body.source, text });
      const { intervened, assessment } = this.assess(g, text);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: { usage: { topicPolicyUnits: 1, contentPolicyUnits: 1 }, action: intervened ? 'GUARDRAIL_INTERVENED' : 'NONE', ...(intervened ? { actionReason: 'Guardrail blocked.' } : {}), outputs: intervened ? [{ text: body.source === 'INPUT' ? (g.blockedInput ?? 'Sorry, the model cannot answer this question.') : (g.blockedOutput ?? 'Sorry, the model cannot answer this question.') }] : [], assessments: [assessment] } };
    }
    const run = /^\/model\/([^/]+)\/(converse|converse-stream|invoke)$/.exec(r.path);
    if (r.method === 'POST' && run) {
      const id = decodeURIComponent(run[1]!);
      const profile = this.profiles.find((p) => p.id === id);
      const m = this.offered(region).find((x) => x.modelId === (profile?.modelId ?? id));
      if (!m) return err(404, 'ResourceNotFoundException', `Model ${id} not found in ${region}`);
      if ((m.access ?? 'granted') !== 'granted') return err(403, 'AccessDeniedException', `You don't have access to the model with the specified model ID.`);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(r.body) as Record<string, unknown>;
      } catch {
        return err(400, 'ValidationException', 'Malformed input request');
      }
      if (run[2] === 'invoke') return this.invoke(id, region, body);
      const call: ConverseCall = { op: run[2] === 'converse' ? 'Converse' : 'ConverseStream', modelId: id, region, body: body as ConverseCall['body'], sessionToken: token };
      this.converseCalls.push(call);
      const problem = this.validate(call.body);
      if (problem) return err(400, 'ValidationException', problem);
      if (call.op === 'ConverseStream' && m.noStreamTools && call.body.toolConfig) return err(400, 'ValidationException', 'This model doesn\'t support tool use in streaming mode.');
      // Sprint 61 (B-10506): a guardrail attached as guardrailConfig checks the last user text, then the answer.
      const gc = call.body.guardrailConfig;
      const g = gc?.guardrailIdentifier ? this.guardrail(gc.guardrailIdentifier, gc.guardrailVersion ?? 'DRAFT') : null;
      if (gc && !g) return err(400, 'ValidationException', `The guardrail ${gc.guardrailIdentifier} version ${gc.guardrailVersion} was not found.`);
      let out = this.reply(call);
      let trace: Record<string, unknown> | null = null;
      if (g) {
        const lastUser = [...(call.body.messages ?? [])].reverse().find((m) => m.role === 'user');
        const prompt = (lastUser?.content ?? []).map((b) => (typeof b.text === 'string' ? b.text : '')).join(' ');
        const input = this.assess(g, prompt);
        const output = input.intervened ? null : this.assess(g, out.text ?? '');
        trace = { guardrail: { inputAssessment: { [g.id]: input.assessment }, ...(output ? { outputAssessments: { [g.id]: [output.assessment] } } : {}) } };
        if (input.intervened) out = { text: g.blockedInput ?? 'Sorry, the model cannot answer this question.', stopReason: 'guardrail_intervened' };
        else if (output?.intervened) out = { text: g.blockedOutput ?? 'Sorry, the model cannot answer this question.', stopReason: 'guardrail_intervened' };
      }
      const usage: Record<string, number> = { inputTokens: 11 + JSON.stringify(call.body.messages ?? []).length % 50, outputTokens: Math.max(1, Math.ceil(((out.text ?? '').length + (out.toolUse ? JSON.stringify(out.toolUse).length : 0)) / 4)), totalTokens: 0 };
      if (this.cacheTokens) Object.assign(usage, { cacheReadInputTokens: this.cacheTokens.read, cacheWriteInputTokens: this.cacheTokens.write });
      usage.totalTokens = usage.inputTokens! + usage.outputTokens! + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0);
      const stop = out.stopReason ?? (out.toolUse ? 'tool_use' : 'end_turn');
      if (call.op === 'Converse') {
        const content: Record<string, unknown>[] = [];
        if (out.reasoning) content.push({ reasoningContent: { reasoningText: { text: out.reasoning } } });
        if (out.text) content.push({ text: out.text });
        if (out.toolUse) content.push({ toolUse: { toolUseId: 'tooluse_FAKE0001', name: out.toolUse.name, input: out.toolUse.input } });
        return { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'req-converse' }, body: { output: { message: { role: 'assistant', content } }, stopReason: stop, usage, metrics: { latencyMs: 12 }, ...(trace && gc?.trace === 'enabled' ? { trace } : {}) } };
      }
      const frames: Buffer[] = [event('messageStart', { role: 'assistant' })];
      let index = 0;
      if (out.reasoning) {
        frames.push(event('contentBlockDelta', { contentBlockIndex: index, delta: { reasoningContent: { text: out.reasoning } } }), event('contentBlockStop', { contentBlockIndex: index }));
        index++;
      }
      if (out.text) {
        const words = out.text.match(/\S+\s*/g) ?? [out.text];
        for (const [i, w] of words.entries()) {
          frames.push(event('contentBlockDelta', { contentBlockIndex: index, delta: { text: w } }));
          if (i === 0 && this.streamFailure) {
            frames.push(exception(this.streamFailure.type, this.streamFailure.message));
            this.streamFailure = null;
            return this.chunked(frames);
          }
        }
        frames.push(event('contentBlockStop', { contentBlockIndex: index }));
        index++;
      }
      if (out.toolUse) {
        const input = JSON.stringify(out.toolUse.input);
        const cut = Math.floor(input.length / 2);
        frames.push(event('contentBlockStart', { contentBlockIndex: index, start: { toolUse: { toolUseId: 'tooluse_FAKE0001', name: out.toolUse.name } } }), event('contentBlockDelta', { contentBlockIndex: index, delta: { toolUse: { input: input.slice(0, cut) } } }), event('contentBlockDelta', { contentBlockIndex: index, delta: { toolUse: { input: input.slice(cut) } } }), event('contentBlockStop', { contentBlockIndex: index }));
      }
      frames.push(event('messageStop', { stopReason: stop }), event('metadata', { usage, metrics: { latencyMs: 12 }, ...(trace && gc?.trace === 'enabled' ? { trace } : {}) }));
      return this.chunked(frames);
    }
    return err(404, 'UnknownOperationException', `${r.method} ${r.path} is not something this fake answers`);
  }

  /** The frames as one byte stream cut into small pieces, so frames arrive split across reads. */
  private chunked(frames: Buffer[]): Reply {
    const all = Buffer.concat(frames);
    const chunks: Buffer[] = [];
    for (let i = 0; i < all.length; i += this.pieceBytes) chunks.push(all.subarray(i, i + this.pieceBytes));
    return { status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream', 'x-amzn-requestid': 'req-stream' }, chunks, gapMs: 0 };
  }

  /** Converse's own rules: alternating turns starting with the user, tool results answering the turn before, no blank text. */
  private validate(body: ConverseCall['body']): string | null {
    const msgs = body.messages ?? [];
    if (!msgs.length || msgs[0]!.role !== 'user') return 'A conversation must start with a user message.';
    let pendingTools: string[] = [];
    for (const [i, m] of msgs.entries()) {
      if (i > 0 && msgs[i - 1]!.role === m.role) return 'A conversation must alternate between user and assistant roles.';
      for (const b of m.content) if (typeof b.text === 'string' && !b.text.trim()) return 'The text field in the ContentBlock object is blank.';
      const results = m.content.filter((b) => b.toolResult).map((b) => String((b.toolResult as { toolUseId: string }).toolUseId));
      if (results.some((id) => !pendingTools.includes(id))) return 'The toolResult blocks must answer the toolUse blocks of the previous turn.';
      pendingTools = m.content.filter((b) => b.toolUse).map((b) => String((b.toolUse as { toolUseId: string }).toolUseId));
      if (pendingTools.length && !body.toolConfig) return 'The toolConfig field must be defined when using toolUse and toolResult content blocks.';
    }
    return null;
  }

  private invoke(id: string, region: string, body: Record<string, unknown>): Reply {
    this.invokeCalls.push({ modelId: id, region, body });
    if (id.startsWith('amazon.titan-embed')) {
      const text = String(body.inputText ?? '');
      return { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-bedrock-input-token-count': String(Math.ceil(text.length / 4)) }, body: { embedding: vectorOf(text), inputTextTokenCount: Math.ceil(text.length / 4) } };
    }
    if (id.startsWith('cohere.embed')) {
      const texts = (body.texts as string[] | undefined) ?? [];
      if (texts.length > 96) return err(400, 'ValidationException', 'texts: at most 96');
      return { status: 200, headers: { 'content-type': 'application/json', 'x-amzn-bedrock-input-token-count': String(texts.reduce((a, t) => a + Math.ceil(t.length / 4), 0)) }, body: { id: 'emb-1', response_type: 'embeddings_floats', texts, embeddings: texts.map(vectorOf) } };
    }
    return err(400, 'ValidationException', `${id} is not invoked this way here`);
  }
}
