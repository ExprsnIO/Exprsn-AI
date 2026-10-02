import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { ulid } from 'ulid';
import { ZodError } from 'zod';
import { LABELS, isLabel, type Label } from '../authz/labels.js';
import { authorize } from '../authz/policy.js';
import { authenticate, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { checkContentDigest, ed25519PublicKey, verifyMessage } from '../crypto/httpsig.js';
import { HeldRequest } from './holds.js';
import { responsesBody } from './responses.js';
import { apiProblem, chatBody, completionObject, embeddingsBody, type CompletionResult, type Extensions } from './service.js';

/*
 * `/v1`: the OpenAI-compatible API. Bearer credentials only (an API key or an OAuth access token); the session cookie
 * is never read here, so no CSRF token is needed. Errors use OpenAI's shape `{ error: { message, type, code, param } }`
 * rather than problem+json, because that is what OpenAI clients parse. The data label of a request is `internal`
 * unless the `X-Data-Label` header says otherwise; `X-Workspace` picks the workspace as it does for `/api`.
 */

const typeFor = (status: number): string =>
  status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : 'api_error';

export function openAiError(err: unknown): { status: number; body: { error: { message: string; type: string; code: string | null; param: string | null } }; headers: Record<string, string> } {
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return { status: 400, headers: {}, body: { error: { message: i ? `${i.path.join('.') || 'body'}: ${i.message}` : 'The request did not validate.', type: 'invalid_request_error', code: 'invalid_request', param: i?.path.join('.') || null } } };
  }
  if (err instanceof HttpProblem) {
    const ext = err.extensions;
    let code = typeof ext.code === 'string' ? ext.code : null;
    if (!code) {
      if (err.status === 401) code = 'invalid_api_key';
      else if (err.status === 403) code = typeof ext.step === 'string' ? `denied_${ext.step}` : 'permission_denied';
      else if (err.status === 429) code = typeof ext.limit === 'string' ? 'insufficient_quota' : 'rate_limit_exceeded';
      else if (err.status === 400 && Array.isArray(ext.errors)) code = 'invalid_request';
    }
    let message = err.detail ?? err.title;
    const first = Array.isArray(ext.errors) ? (ext.errors[0] as { path?: string; message?: string } | undefined) : undefined;
    if (first?.message) message = `${first.path ? `${first.path}: ` : ''}${first.message}`;
    return { status: err.status, headers: err.headers, body: { error: { message, type: typeFor(err.status), code, param: typeof ext.param === 'string' ? ext.param : (first?.path ?? null) } } };
  }
  const e = err as { type?: string };
  if (e?.type === 'entity.parse.failed') return { status: 400, headers: {}, body: { error: { message: 'The body is not valid JSON.', type: 'invalid_request_error', code: 'invalid_json', param: null } } };
  if (e?.type === 'entity.too.large') return { status: 413, headers: {}, body: { error: { message: 'The request body is too large.', type: 'invalid_request_error', code: 'request_too_large', param: null } } };
  return { status: 500, headers: {}, body: { error: { message: 'Something went wrong on our side. Quote the X-Trace-Id header if you report it.', type: 'api_error', code: 'internal_error', param: null } } };
}

/** The request's data label: X-Data-Label, or the caller's default (internal, or a lower workspace ceiling). */
const labelOf = async (s: Services, req: Request): Promise<Label> => {
  const h = req.header('x-data-label');
  if (h == null || h === '') return s.chat.defaultLabel(principalOf(req));
  if (!isLabel(h)) throw apiProblem(400, `X-Data-Label must be one of ${LABELS.join(', ')}.`, 'invalid_label', 'X-Data-Label');
  return h;
};

/**
 * Sprint 16 request extensions: `X-Exprsn-Knowledge: <id>[,<id>…]` retrieves from those knowledge bases,
 * `X-Exprsn-Memory: on` adds the caller's memories, `X-Exprsn-Tools: profile` runs the profile's read-only tools on
 * the server. Citations and the tools that ran come back in the `exprsn` field.
 */
const extensionsOf = (req: Request): Extensions => {
  const out: Extensions = {};
  const kb = req.header('x-exprsn-knowledge');
  if (kb != null && kb.trim() !== '') {
    const ids = [...new Set(kb.split(',').map((x) => x.trim()).filter(Boolean))];
    if (ids.length > 10 || ids.some((x) => !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(x))) throw apiProblem(400, 'X-Exprsn-Knowledge must list up to 10 knowledge base ids, separated by commas.', 'invalid_header', 'X-Exprsn-Knowledge');
    out.knowledge = ids;
  }
  const mem = req.header('x-exprsn-memory');
  if (mem != null && mem !== '') {
    if (mem !== 'on' && mem !== 'off') throw apiProblem(400, 'X-Exprsn-Memory must be on or off.', 'invalid_header', 'X-Exprsn-Memory');
    out.memory = mem === 'on';
  }
  const tools = req.header('x-exprsn-tools');
  if (tools != null && tools !== '') {
    if (tools !== 'profile' && tools !== 'none') throw apiProblem(400, 'X-Exprsn-Tools must be profile or none.', 'invalid_header', 'X-Exprsn-Tools');
    out.serverTools = tools === 'profile';
  }
  return out;
};

const completion = (r: CompletionResult) => completionObject(r);

export function openAiRoutes(s: Services): Router {
  const r = Router();
  const limiter = new RateLimiterMemory({ points: 600, duration: 60 });
  const auth = authenticate(s);

  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // The raw body is kept for RFC 9421 Content-Digest checks (B-1203).
  r.use(express.json({ limit: '8mb', strict: true, verify: (req, _res, buf) => void ((req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf)) }));
  r.use((req, res, next) => {
    if (!req.headers.authorization) throw new HttpProblem(401, 'Unauthorized', 'Send an API key or an access token as "Authorization: Bearer <credential>".', { extensions: { code: 'missing_api_key' } });
    return auth(req, res, next);
  });
  r.use(requireAuth());
  // Sprint 20 (B-1203): an API key with a registered public key accepts only requests signed with it (RFC 9421).
  r.use(async (req, _res, next) => {
    const key = req.apiKey;
    if (key?.signature_key) await verifySignedRequest(s, req, key.id, `exai_k1_${key.prefix}`, key.signature_key);
    next();
  });
  r.use(async (req, _res, next) => {
    try {
      await limiter.consume(principalOf(req).userId);
    } catch (x) {
      const ms = (x as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      throw new HttpProblem(429, 'Too many requests', 'Slow down: too many requests.', { headers: { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) } });
    }
    next();
  });
  const invoke = requirePermission(s, 'inference:invoke');

  r.get('/models', invoke, async (req, res) => {
    res.json({ object: 'list', data: await s.openai.models(principalOf(req)) });
  });

  r.get('/models/:id', invoke, async (req, res) => {
    const m = (await s.openai.models(principalOf(req))).find((x) => x.id === String(req.params.id));
    if (!m) throw apiProblem(404, `The model ${String(req.params.id)} does not exist or you do not have access to it.`, 'model_not_found', 'model');
    res.json(m);
  });

  r.post('/chat/completions', invoke, async (req, res) => {
    const p = principalOf(req);
    const body = chatBody.parse(req.body);
    const label = await labelOf(s, req);
    const ext = extensionsOf(req);
    // Each extension reads more than inference does: it needs its own permission (and scope, for a key or token).
    for (const [on, action, header] of [[!!ext.knowledge?.length, 'knowledge:read', 'X-Exprsn-Knowledge'], [!!ext.memory, 'memory:write', 'X-Exprsn-Memory'], [!!ext.serverTools, 'tools:invoke', 'X-Exprsn-Tools']] as const) {
      if (!on) continue;
      const d = authorize(p, action);
      if (!d.allow) throw new HttpProblem(403, 'Forbidden', `${header} needs ${action}: ${d.reason}`, { extensions: { code: `denied_${d.step}`, param: header, step: d.step, action } });
    }
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(new Error('client went away'));
    });
    // B-1301: with an API key, a prompt a `require-approval` rule stops is held for review (202, then GET /v1/held/:id).
    const input = s.openai.holds.mode(p, 'chat.completions', body, ext, label);
    if (!body.stream) {
      res.json(completion(await s.openai.chat(p, body, label, ac.signal, { ext, input })));
      return;
    }
    await stream(res, s, async (send) => {
      const base = { object: 'chat.completion.chunk', model: body.model, system_fingerprint: null };
      const id = `chatcmpl-${ulid()}`;
      const created = Math.floor(Date.now() / 1000);
      let opened = false;
      const open = () => {
        if (opened) return;
        opened = true;
        send({ ...base, id, created, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }] });
      };
      const result = await s.openai.chat(p, body, label, ac.signal, {
        id,
        ext,
        input,
        onDelta: (text) => {
          open();
          send({ ...base, id, created, choices: [{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }] });
        }
      });
      if (!opened) {
        open();
        // Checked mode: the answer is released after the output checkpoint, in one piece.
        if (result.content) send({ ...base, id, created, choices: [{ index: 0, delta: { content: result.content }, logprobs: null, finish_reason: null }] });
      }
      result.toolCalls.forEach((c, index) => send({ ...base, id, created, choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments } }] }, logprobs: null, finish_reason: null }] }));
      send({ ...base, id, created, choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: result.finishReason }], ...(result.exprsn ? { exprsn: result.exprsn } : {}) });
      if (body.stream_options?.include_usage) send({ ...base, id, created, choices: [], usage: result.usage });
    });
  });

  r.post('/embeddings', invoke, async (req, res) => {
    const body = embeddingsBody.parse(req.body);
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(new Error('client went away'));
    });
    res.json(await s.openai.embeddings(principalOf(req), body, await labelOf(s, req), ac.signal));
  });

  // ---------- Sprint 21: the Responses API subset (B-1302) and held requests (B-1301) ----------

  r.post('/responses', invoke, async (req, res) => {
    const p = principalOf(req);
    const body = responsesBody.parse(req.body);
    const label = await labelOf(s, req);
    const ext = extensionsOf(req);
    for (const [on, action, header] of [[!!ext.knowledge?.length, 'knowledge:read', 'X-Exprsn-Knowledge'], [!!ext.memory, 'memory:write', 'X-Exprsn-Memory'], [!!ext.serverTools, 'tools:invoke', 'X-Exprsn-Tools']] as const) {
      if (!on) continue;
      const d = authorize(p, action);
      if (!d.allow) throw new HttpProblem(403, 'Forbidden', `${header} needs ${action}: ${d.reason}`, { extensions: { code: `denied_${d.step}`, param: header, step: d.step, action } });
    }
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort(new Error('client went away'));
    });
    if (!body.stream) {
      res.json(await s.openai.responses.create(p, body, label, ac.signal, { ext }));
      return;
    }
    await stream(res, s, async (_send, event) => {
      await s.openai.responses.create(p, body, label, ac.signal, { ext, onEvent: (type, data) => event(type, data) });
    }, { done: false });
  });

  r.get('/responses/:id', invoke, async (req, res) => {
    res.json(await s.openai.responses.retrieve(principalOf(req), String(req.params.id)));
  });

  r.get('/held/:id', invoke, async (req, res) => {
    const id = String(req.params.id);
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw apiProblem(404, 'No such held request.', 'held_request_not_found');
    try {
      res.json(await s.openai.holds.get(principalOf(req), id));
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 404) throw apiProblem(404, 'No such held request.', 'held_request_not_found');
      throw err;
    }
  });

  r.use(() => {
    throw apiProblem(404, 'Unknown API route.', 'unknown_url');
  });
  r.use(openAiErrorHandler(s));
  return r;
}

/**
 * Checks a `/v1` request's HTTP Message Signature (RFC 9421) against the API key's Ed25519 public key. The signature
 * must cover `@method`, `@target-uri` (the public URL the client called) and `authorization`, plus `content-digest`
 * (RFC 9530, checked against the body) whenever there is a body, and be created within HTTP_SIGNATURE_MAX_AGE_SECONDS.
 * `keyid`, when given, must name this API key (its id or its `exai_k1_<prefix>`).
 */
async function verifySignedRequest(s: Services, req: Request, keyId: string, prefix: string, x: string): Promise<void> {
  const refuse = (detail: string): never => {
    throw new HttpProblem(401, 'Unauthorized', detail, { extensions: { code: 'invalid_signature' } });
  };
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const hasBody = !!raw && raw.length > 0;
  if (hasBody && !checkContentDigest(req.header('content-digest'), raw)) refuse('This API key requires signed requests: Content-Digest is missing or does not match the body.');
  const v = await verifyMessage(
    { method: req.method, url: `${s.cfg.ORIGIN}${req.originalUrl}`, headers: req.headers },
    {
      required: ['@method', '@target-uri', 'authorization', ...(hasBody ? ['content-digest'] : [])],
      maxAgeSeconds: s.cfg.HTTP_SIGNATURE_MAX_AGE_SECONDS,
      keyFor: (keyid) => (keyid == null || keyid === keyId || keyid === prefix ? { alg: 'ed25519', key: ed25519PublicKey(x) } : null)
    }
  );
  if (!v.ok) refuse(`This API key requires signed requests (RFC 9421): ${v.reason}`);
}

/**
 * Server-sent events: `data: <json>` per chunk, comments as keep-alives while nothing is sent, `data: [DONE]` last.
 * Named events (`event: <type>`) are for the Responses API, which ends without `[DONE]` and reports errors as an
 * `error` event.
 */
async function stream(res: Response, s: Services, body: (send: (o: unknown) => void, event: (type: string, o: unknown) => void) => Promise<void>, opts: { done?: boolean } = {}): Promise<void> {
  const done = opts.done !== false;
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  };
  const write = (line: string) => {
    start();
    res.write(line);
    (res as unknown as { flush?: () => void }).flush?.();
  };
  // Nothing is sent until the first chunk, so a refusal before generation (an unknown model, a quota, a guardrail)
  // is still an ordinary HTTP error; a comment every 10 s keeps proxies from timing out while the answer is checked.
  const keepAlive = setInterval(() => write(': keep-alive\n\n'), 10_000);
  try {
    await body(
      (o) => write(`data: ${JSON.stringify(o)}\n\n`),
      (type, o) => write(`event: ${type}\ndata: ${JSON.stringify(o)}\n\n`)
    );
    if (done) write('data: [DONE]\n\n');
  } catch (err) {
    clearInterval(keepAlive);
    if (!started) throw err;
    const e = openAiError(err);
    if (e.status >= 500) s.log.error({ err }, 'openai stream failed');
    if (!res.writableEnded) write(done ? `data: ${JSON.stringify(e.body)}\n\n` : `event: error\ndata: ${JSON.stringify({ type: 'error', code: e.body.error.code, message: e.body.error.message, param: e.body.error.param })}\n\n`);
  } finally {
    clearInterval(keepAlive);
    if (started && !res.writableEnded) res.end();
  }
}

export function openAiErrorHandler(s: Pick<Services, 'log'>): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HeldRequest && !res.headersSent) {
      // B-1301: held for review. The client polls the held request for the answer.
      res.setHeader('Location', err.view.poll);
      res.status(202).json(err.view);
      return;
    }
    const e = openAiError(err);
    if (e.status >= 500) s.log.error({ err, trace_id: req.traceId }, 'openai api error');
    if (res.headersSent) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
    res.status(e.status).json(e.body);
  };
}
