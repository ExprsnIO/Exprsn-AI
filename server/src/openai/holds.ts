import { ulid } from 'ulid';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { actorFrom } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import type { GuardDecision } from '../guardrails/types.js';
import type { Services } from '../services.js';
import { completionObject, type ChatBody, type Extensions, type InputMode } from './service.js';
import type { ResponsesBody } from './responses.js';

/*
 * Held `/v1` requests (B-1301). When a `require-approval` rule at `user-input` stops a request sent with an API key,
 * the request is not refused: it is stored sealed, filed in the Flags queue like a held chat prompt, and the client
 * gets `202` with the held request's id and a polling route. A reviewer other than the sender approves it (the request
 * then runs as a job, as the sender with the key's scopes as they are now; a revoked or expired key, or a disabled
 * owner, fails it) or rejects it. The answer is stored sealed until the client fetches it from `GET /v1/held/:id`.
 */

export type HeldApi = 'chat.completions' | 'responses';
export type HoldState = 'held' | 'running' | 'completed' | 'failed' | 'rejected';

interface HoldRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  api_key_id: string | null;
  api: HeldApi;
  label: Label;
  request: string;
  state: HoldState;
  result: string | null;
  error: string | null;
  flag_id: string | null;
  job_id: string | null;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
  completed_at: number | null;
}

/** What is sealed with a held request: the body as sent, the extensions, the held text and the credential's narrowing. */
interface StoredRequest {
  body: ChatBody | ResponsesBody;
  ext: Extensions;
  text: string;
  scopes: Permission[] | null;
  profiles: string[] | null;
}

/** Thrown by the `/v1` paths when a request was held; the error handler answers `202` with the view. */
export class HeldRequest extends Error {
  constructor(readonly view: ReturnType<ApiHolds['view']>) {
    super('The request is held for review.');
  }
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): HoldRow => ({ ...(r as unknown as HoldRow), created_at: Number(r.created_at), decided_at: num(r.decided_at), completed_at: num(r.completed_at) });

export class ApiHolds {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('openai.held', async (p, ctx) => this.run(String(p.id), ctx.signal), { timeoutMs: 15 * 60_000 });
  }

  /**
   * The input mode for a `/v1` request: holdable when it was sent with an API key and the Flags queue exists. An
   * OAuth access token can expire or be revoked while a reviewer decides, so such requests are refused as before.
   */
  mode(p: Principal, api: HeldApi, body: ChatBody | ResponsesBody, ext: Extensions, label: Label, extra: Partial<InputMode> = {}): InputMode {
    if (!p.apiKeyId) return extra;
    return { ...extra, holdable: true, onHold: (hold) => this.file(p, api, body, ext, label, hold) };
  }

  view(r: Pick<HoldRow, 'id' | 'api' | 'state' | 'created_at' | 'error'>, response?: unknown) {
    return {
      id: r.id,
      object: 'exprsn.held_request' as const,
      api: r.api,
      status: r.state,
      created: Math.floor(r.created_at / 1000),
      poll: `/v1/held/${r.id}`,
      ...(r.state === 'held' ? { message: 'A guardrail held this request for review. Poll the URL in poll until a reviewer decides.' } : {}),
      ...(r.state === 'rejected' ? { message: 'A reviewer rejected this request; it was not sent to the model.' } : {}),
      ...(r.state === 'failed' ? { error: { message: r.error ?? 'The request failed after approval.', type: 'api_error', code: 'held_request_failed' } } : {}),
      ...(response !== undefined ? { response } : {})
    };
  }

  /** Stores the request sealed, files it for review and throws `HeldRequest`. */
  private async file(p: Principal, api: HeldApi, body: ChatBody | ResponsesBody, ext: Extensions, label: Label, hold: { decision: GuardDecision; text: string }): Promise<never> {
    const s = this.s();
    const id = ulid();
    const t = Date.now();
    const stored: StoredRequest = { body, ext, text: hold.text, scopes: p.scopes, profiles: p.profiles ?? null };
    const row: HoldRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, api_key_id: p.apiKeyId, api, label, request: await s.keys.seal(p.tenantId, JSON.stringify(stored), `api-hold:${id}`), state: 'held', result: null, error: null, flag_id: null, job_id: null, decided_by: null, created_at: t, decided_at: null, completed_at: null };
    await this.db('api_holds').insert(row);
    const d = hold.decision;
    const f = d.findings.find((x) => x.stage === 'enforce' && x.action === 'require-approval');
    const flag = await s.guard.flags.create({
      tenantId: p.tenantId,
      workspaceId: p.workspaceId ?? null,
      kind: 'hold',
      checkpoint: 'user-input',
      ruleId: f?.ruleId ?? null,
      ruleName: f?.ruleName ?? 'Held for review',
      setId: f?.setId ?? null,
      stage: 'enforce',
      action: 'require-approval',
      severity: 'medium',
      label,
      text: hold.text,
      span: f?.span ?? null,
      note: d.reason ?? 'A guardrail held this API request for review before it reaches the model.',
      actor: { user: p.userId, name: p.displayName, via: 'openai-api' },
      source: { kind: 'api-request', id },
      conversationId: null
    });
    await this.db('api_holds').where({ id }).update({ flag_id: flag.id });
    await s.audit.append({ tenantId: p.tenantId, action: 'api.request.held', kind: 'system', actor: actorFrom(p), target: { request: id, flag: `F-${flag.number}`, api }, label, detail: { rule: f?.ruleName ?? null, reason: d.reason ?? null } });
    throw new HeldRequest(this.view(row));
  }

  private async row(tenantId: string, id: string): Promise<HoldRow | null> {
    const r = (await this.db('api_holds').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : null;
  }

  /** The held request for its sender: the status, and the answer once there is one. */
  async get(p: Principal, id: string) {
    const r = await this.row(p.tenantId, id);
    if (!r || r.user_id !== p.userId) throw notFound('Held request');
    const response = r.state === 'completed' && r.result ? (JSON.parse(await this.s().keys.open(r.tenant_id, r.result, `api-hold-result:${r.id}`)) as unknown) : undefined;
    return this.view(r, response);
  }

  /** The held text for a reviewer cleared for the flag (the flag detail shows it). */
  async heldText(tenantId: string, id: string): Promise<{ conversationId: string; state: string; content: string } | null> {
    const r = await this.row(tenantId, id);
    if (!r) return null;
    const req = JSON.parse(await this.s().keys.open(r.tenant_id, r.request, `api-hold:${r.id}`)) as StoredRequest;
    return { conversationId: '', state: r.state, content: req.text };
  }

  /** A reviewer's decision, from the flag queue. The sender never decides on their own request. */
  async resolve(reviewer: Principal, id: string, decision: 'approved' | 'rejected'): Promise<{ state: HoldState; label: Label }> {
    const s = this.s();
    const r = await this.row(reviewer.tenantId, id);
    if (!r) throw notFound('Held request');
    if (r.state !== 'held') throw conflict(`This request is ${r.state}, not held for review.`);
    if (r.user_id === reviewer.userId) throw forbidden('You sent this request; another reviewer decides on it.', { step: 'dual-control' });
    const state: HoldState = decision === 'approved' ? 'running' : 'rejected';
    const n = await this.db('api_holds').where({ id: r.id, state: 'held' }).update({ state, decided_by: reviewer.userId, decided_at: Date.now() });
    if (!n) throw conflict('Another reviewer decided on this request first.');
    if (decision === 'approved') {
      const job = await s.jobs.enqueue({ tenantId: r.tenant_id, type: 'openai.held', payload: { id: r.id }, createdBy: r.user_id, maxAttempts: 1 });
      await this.db('api_holds').where({ id: r.id }).update({ job_id: job.id });
    }
    await s.notifications.notify({ tenantId: r.tenant_id, userIds: [r.user_id], kind: 'api', title: decision === 'approved' ? 'An API request held for review was approved' : 'An API request held for review was rejected', body: decision === 'approved' ? `It is being answered; fetch it from /v1/held/${r.id}.` : 'A reviewer rejected it; it was not sent to the model.', label: r.label });
    return { state, label: r.label };
  }

  /** The sender as a principal now, narrowed as the credential was; null with the reason when it can no longer act. */
  private async sender(r: HoldRow, req: StoredRequest): Promise<Principal | string> {
    const s = this.s();
    const base = await loadPrincipal(s, r.tenant_id, r.user_id, {});
    if (!base) return 'The account that sent this request can no longer use the API.';
    if (r.api_key_id) {
      const k = (await this.db('api_keys').where({ id: r.api_key_id }).first()) as { revoked_at: number | null; expires_at: number } | undefined;
      if (!k || k.revoked_at != null || Number(k.expires_at) <= Date.now()) return 'The API key that sent this request was revoked or has expired.';
    }
    return { ...base, kind: r.api_key_id ? 'api_key' : base.kind, scopes: req.scopes, apiKeyId: r.api_key_id, profiles: req.profiles, workspaceId: r.workspace_id, mfa: true };
  }

  /** The job: runs an approved request as its sender and stores the answer sealed. */
  private async run(id: string, signal: AbortSignal): Promise<unknown> {
    const s = this.s();
    const r = (await this.db('api_holds').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) return { skipped: 'gone' };
    const row = fromRow(r);
    if (row.state !== 'running') return { skipped: row.state };
    const fail = async (error: string) => {
      await this.db('api_holds').where({ id }).update({ state: 'failed', error: error.slice(0, 500), completed_at: Date.now() });
      await s.notifications.notify({ tenantId: row.tenant_id, userIds: [row.user_id], kind: 'api', title: 'An approved API request failed', body: error.slice(0, 300), label: row.label });
      return { state: 'failed', error };
    };
    const req = JSON.parse(await s.keys.open(row.tenant_id, row.request, `api-hold:${row.id}`)) as StoredRequest;
    const p = await this.sender(row, req);
    if (typeof p === 'string') return fail(p);
    let result: unknown;
    try {
      if (row.api === 'responses') result = await s.openai.responses.create(p, req.body as ResponsesBody, row.label, signal, { ext: req.ext, approved: true });
      else result = completionObject(await s.openai.chat(p, req.body as ChatBody, row.label, signal, { ext: req.ext, input: { approved: true } }));
    } catch (err) {
      return fail(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
    }
    await this.db('api_holds').where({ id }).update({ state: 'completed', result: await s.keys.seal(row.tenant_id, JSON.stringify(result), `api-hold-result:${row.id}`), completed_at: Date.now() });
    await s.notifications.notify({ tenantId: row.tenant_id, userIds: [row.user_id], kind: 'api', title: 'An API request held for review was answered', body: `Fetch the answer from /v1/held/${row.id}.`, label: row.label });
    return { state: 'completed' };
  }
}
