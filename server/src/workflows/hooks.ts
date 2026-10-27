import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { emptyGraph, graphSchema, type WfGraph } from './graph.js';
import { curlExample, HOOK_MAX_BYTES, HOOK_SIGNING, HOOK_WINDOW_SECONDS, SignedHooks, type SignedRequest } from './signed-hooks.js';
import type { WorkflowRow } from './service.js';
import { triggerConfigSchema } from './trigger-config.js';

/*
 * The webhook trigger of every workflow (1.8.0, Sprint 46, B-130; migration 085). A workflow whose trigger step has
 * source `webhook` is started by a signed POST to `/hooks/workflows/<tenant>/<workflowId>` (outside `/api`, no
 * session). The signature, window, replay, size, rate and content checks are the app flows' (`signed-hooks.ts`):
 *
 * - The hook is off until a workflow admin makes its secret and turns it on. Whoever turns it on owns its runs, as the
 *   publisher owns an event trigger's, and is loaded again for every request: active, holding `agents:run`, cleared
 *   for the workflow's label and still a member of its workspace.
 * - The published version's trigger must be `webhook`; a hook that is off, has no secret, or whose workflow has no
 *   published webhook trigger answers 404 like a workflow that does not exist.
 * - The verified JSON object passes `untrusted-content` and `user-input` at the workflow's label before a run exists,
 *   then becomes the run input, the trigger's output: checked against the trigger's output schema when one is set
 *   (400 when it does not match), and the run carries the workflow's label.
 * - The secret is sealed under the tenant key with `workflowhook:<id>` as associated data and shown once; rotating
 *   replaces it at once (no grace period) and forgets the signatures seen.
 * - Accepted and refused deliveries are counted on the hook row, the newest 50 kept in `workflow_hook_deliveries`, and
 *   audited (`workflow.hook.received`, `workflow.hook.refused`); a request for a workflow that does not exist is not.
 */

const DELIVERIES_KEPT = 50;
const aad = (workflowId: string) => `workflowhook:${workflowId}`;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface WorkflowHookRequest extends SignedRequest {
  tenant: string;
  workflowId: string;
}

interface HookRow {
  workflow_id: string;
  tenant_id: string;
  enabled: boolean;
  secret: string | null;
  secret_at: number | null;
  owner_id: string | null;
  received: number;
  refused: number;
  last_received_at: number | null;
  last_refused_at: number | null;
  last_run_id: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const n0 = (v: unknown) => (v == null ? null : Number(v));
const hookFrom = (r: Record<string, unknown>): HookRow => ({ ...(r as unknown as HookRow), enabled: !!r.enabled, secret_at: n0(r.secret_at), received: Number(r.received ?? 0), refused: Number(r.refused ?? 0), last_received_at: n0(r.last_received_at), last_refused_at: n0(r.last_refused_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

interface Ctx {
  ip?: string | null;
  traceId?: string;
}

/** The trigger source of a graph (manual when it has none). */
const sourceOf = (g: WfGraph | null): string | null => {
  const t = g?.nodes.find((n) => n.kind === 'trigger');
  if (!t) return null;
  const c = triggerConfigSchema.safeParse(t.config ?? {});
  return c.success ? c.data.source : null;
};

export class WorkflowHooks {
  private readonly core: SignedHooks;

  constructor(private readonly s: () => Services) {
    this.core = new SignedHooks(s, 'workflow-hook');
  }

  private get db() {
    return this.s().db;
  }

  /** The hook's public path and full URL. */
  async address(tenantId: string, workflowId: string): Promise<{ path: string; url: string }> {
    const t = await this.s().tenants.byId(tenantId);
    const path = `/hooks/workflows/${t?.slug ?? tenantId}/${workflowId}`;
    return { path, url: `${this.s().cfg.PUBLIC_URL.replace(/\/+$/, '')}${path}` };
  }

  private async row(workflowId: string): Promise<HookRow | null> {
    const r = (await this.db('workflow_hooks').where({ workflow_id: workflowId }).first()) as Record<string, unknown> | undefined;
    return r ? hookFrom(r) : null;
  }

  private async published(w: Pick<WorkflowRow, 'id' | 'published_version'>): Promise<WfGraph | null> {
    if (!w.published_version) return null;
    const v = (await this.db('workflow_versions').where({ workflow_id: w.id, version: w.published_version }).first('graph')) as { graph: string } | undefined;
    return v ? graphSchema.parse(JSON.parse(v.graph)) : null;
  }

  /** The workflow as the caller may manage it: in their workspace, within their clearance (`workflows.workflow`). */
  private async target(p: Principal, ref: string): Promise<{ w: WorkflowRow; draft: string | null; live: string | null }> {
    const w = await this.s().workflows.workflow(p, ref);
    const draft = sourceOf(graphSchema.safeParse(json(w.draft, emptyGraph())).data ?? null);
    const live = sourceOf(await this.published(w));
    return { w, draft, live };
  }

  /** Status for the console: on or off, the secret's age, the owner, counts, the URL, how to sign and the last deliveries. */
  async status(p: Principal, ref: string) {
    const { w, draft, live } = await this.target(p, ref);
    return this.view(w, await this.row(w.id), { draft, live });
  }

  private async view(w: WorkflowRow, h: HookRow | null, src: { draft: string | null; live: string | null }) {
    const addr = await this.address(w.tenant_id, w.id);
    const owner = h?.owner_id ? ((await this.db('users').where({ id: h.owner_id, tenant_id: w.tenant_id }).first('display_name')) as { display_name: string } | undefined) : undefined;
    const deliveries = (await this.db('workflow_hook_deliveries').where({ workflow_id: w.id }).orderBy('at', 'desc').limit(20)) as Record<string, unknown>[];
    return {
      workflowId: w.id,
      trigger: { draft: src.draft, published: src.live },
      enabled: !!h?.enabled,
      live: !!h?.enabled && !!h.secret && src.live === 'webhook',
      secretSet: !!h?.secret,
      secretSetAt: h?.secret_at ?? null,
      owner: h?.owner_id ?? null,
      ownerName: owner?.display_name ?? null,
      received: h?.received ?? 0,
      refused: h?.refused ?? 0,
      lastReceivedAt: h?.last_received_at ?? null,
      lastRefusedAt: h?.last_refused_at ?? null,
      lastRunId: h?.last_run_id ?? null,
      ...addr,
      ...HOOK_SIGNING,
      windowSeconds: HOOK_WINDOW_SECONDS,
      example: curlExample(addr.url),
      deliveries: deliveries.map((d) => ({ id: d.id, at: Number(d.at), outcome: d.outcome, status: Number(d.status), reason: d.reason ?? null, runId: d.run_id ?? null, size: Number(d.size ?? 0) }))
    };
  }

  private requireWebhook(w: WorkflowRow, src: { draft: string | null; live: string | null }): void {
    if (src.draft !== 'webhook' && src.live !== 'webhook') throw new HttpProblem(409, 'Not a webhook workflow', `${w.name} starts from a ${src.live ?? src.draft ?? 'manual'} trigger; set its trigger's source to webhook first.`);
  }

  /** Makes or replaces the secret; the secret is in this answer only. The old one stops working at once. */
  async rotate(p: Principal, ref: string, ctx: Ctx = {}) {
    const { w, draft, live } = await this.target(p, ref);
    this.requireWebhook(w, { draft, live });
    const before = await this.row(w.id);
    const { secret, sealed, at } = await this.core.make(w.tenant_id, w.id, aad(w.id));
    if (before) await this.db('workflow_hooks').where({ workflow_id: w.id }).update({ secret: sealed, secret_at: at, updated_by: p.userId, updated_at: at });
    else await this.db('workflow_hooks').insert({ workflow_id: w.id, tenant_id: w.tenant_id, enabled: false, secret: sealed, secret_at: at, owner_id: null, received: 0, refused: 0, updated_by: p.userId, created_at: at, updated_at: at });
    await this.audit(p, ctx, 'workflow.hook.rotated', { workflow: w.id }, w.label, { first: !before?.secret, enabled: !!before?.enabled });
    return { secret, secretSetAt: at, enabled: !!before?.enabled, ...(await this.address(w.tenant_id, w.id)) };
  }

  /** Turns the hook on (the caller becomes its owner, as whom its runs start) or off. */
  async setEnabled(p: Principal, ref: string, enabled: boolean, ctx: Ctx = {}) {
    const { w, draft, live } = await this.target(p, ref);
    const h = await this.row(w.id);
    if (enabled) {
      this.requireWebhook(w, { draft, live });
      if (!h?.secret) throw conflict('Make the webhook secret first (Rotate secret): a hook without a secret cannot verify anything.');
      if (!authorize(p, 'agents:run').allow) throw forbidden('The owner of a webhook runs its workflow and needs agents:run.', { step: 'role' });
    }
    if (!h) {
      // Off with no row: nothing to change.
      return this.view(w, null, { draft, live });
    }
    await this.db('workflow_hooks').where({ workflow_id: w.id }).update({ enabled, ...(enabled ? { owner_id: p.userId } : {}), updated_by: p.userId, updated_at: Date.now() });
    await this.audit(p, ctx, 'workflow.hook.updated', { workflow: w.id }, w.label, { enabled, ...(enabled ? { owner: p.userId } : {}) });
    return this.view(w, await this.row(w.id), { draft, live });
  }

  // ---------- the public endpoint ----------

  private async locate(tenant: string, workflowId: string): Promise<WorkflowRow> {
    if (!SLUG.test(tenant) || !ID.test(workflowId)) throw notFound('Webhook');
    const t = await this.s().tenants.bySlug(tenant);
    if (!t || t.state !== 'active') throw notFound('Webhook');
    const r = (await this.db('workflows').where({ id: workflowId, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Webhook');
    return { ...(r as unknown as WorkflowRow), published_version: n0(r.published_version) };
  }

  /** One delivery on the hook row and the trimmed list (best effort: a hook row may not exist for a refused request). */
  private async delivered(w: WorkflowRow, o: { outcome: 'accepted' | 'refused'; status: number; reason: string | null; runId: string | null; size: number }): Promise<void> {
    const at = Date.now();
    await this.db('workflow_hook_deliveries').insert({ id: ulid(), tenant_id: w.tenant_id, workflow_id: w.id, at, outcome: o.outcome, status: o.status, reason: o.reason?.slice(0, 80) ?? null, run_id: o.runId, size: o.size });
    const old = ((await this.db('workflow_hook_deliveries').where({ workflow_id: w.id }).orderBy('at', 'desc').orderBy('id', 'desc').offset(DELIVERIES_KEPT).limit(500).select('id')) as { id: string }[]).map((x) => x.id);
    if (old.length) await this.db('workflow_hook_deliveries').whereIn('id', old).delete();
    const accepted = o.outcome === 'accepted';
    await this.db('workflow_hooks')
      .where({ workflow_id: w.id })
      .update(accepted ? { received: this.db.raw('received + 1'), last_received_at: at, last_run_id: o.runId } : { refused: this.db.raw('refused + 1'), last_refused_at: at });
  }

  private async refused(w: WorkflowRow, h: HookRow | null, req: SignedRequest, status: number, title: string, reason: string, detail: string, label: Label = 'internal'): Promise<never> {
    await this.s().audit.append({ tenantId: w.tenant_id, action: 'workflow.hook.refused', kind: 'system', actor: { service: 'workflows.hooks', ...(h?.owner_id ? { user: h.owner_id } : {}) }, target: { workflow: w.id }, label, detail: { reason, ip: req.ip, size: req.raw.length }, traceId: req.traceId ?? null });
    await this.delivered(w, { outcome: 'refused', status, reason, runId: null, size: req.raw.length }).catch(() => undefined);
    throw new HttpProblem(status, title, detail);
  }

  /** A body over the limit, refused before it is read in full (audited when the workflow exists). */
  async oversize(req: Omit<WorkflowHookRequest, 'raw'>): Promise<never> {
    const w = await this.locate(req.tenant, req.workflowId).catch(() => null);
    const problem = new HttpProblem(413, 'Payload too large', `A webhook body is at most ${HOOK_MAX_BYTES} bytes.`);
    if (w) await this.refused(w, await this.row(w.id), { ...req, raw: Buffer.alloc(0) }, 413, problem.title, 'oversize', problem.detail ?? '').catch(() => undefined);
    throw problem;
  }

  async receive(req: WorkflowHookRequest): Promise<{ run: string }> {
    const s = this.s();
    const w = await this.locate(req.tenant, req.workflowId);
    await this.core.limit(w.id);
    const h = await this.row(w.id);
    const refuse = (status: number, title: string, reason: string, detail: string, label?: Label) => this.refused(w, h, req, status, title, reason, detail, label);
    const live = sourceOf(await this.published(w));
    if (live !== 'webhook' || !h?.enabled || !h.secret) {
      // The caller learns no more than for a workflow that does not exist.
      await refuse(404, 'Not found', 'disabled', 'Webhook not found.');
    }
    const payload = await this.core.verify({ key: w.id, tenantId: w.tenant_id, sealedSecret: h!.secret!, aad: aad(w.id) }, req, refuse);
    const p = await this.core.owner(w.tenant_id, h!.owner_id, w.workspace_id ?? null, [['agents:run', 'the owner may no longer run workflows']]);
    if (typeof p === 'string') await refuse(409, 'Cannot start', 'owner', `The workflow cannot start: ${p}.`);
    const owner = p as Principal;
    if (!clears(owner.clearance, w.label)) await refuse(409, 'Cannot start', 'owner', `The workflow cannot start: the owner is no longer cleared for ${w.label} data.`);
    const input = await this.core.screen({ tenantId: w.tenant_id, principal: owner, label: w.label, source: { kind: 'workflow-hook', id: w.id }, meta: { workflow: w.id } }, payload, refuse);
    let run: { id: string; label: Label };
    try {
      run = await s.workflows.start(owner, w.id, { input, dry: false, trigger: 'webhook' });
    } catch (err) {
      // The trigger's output schema: the payload is the run input, checked before a run exists.
      if (err instanceof HttpProblem && err.status === 400) return refuse(400, 'Invalid request', 'schema', err.detail ?? 'The payload does not match the trigger.', w.label);
      if (err instanceof HttpProblem && err.status < 500) return refuse(409, 'Cannot start', 'start refused', `The workflow cannot start: ${err.detail ?? err.title}`, w.label);
      throw err;
    }
    await s.audit.append({ tenantId: w.tenant_id, action: 'workflow.hook.received', kind: 'system', actor: { service: 'workflows.hooks', user: owner.userId }, target: { workflow: w.id, run: run.id }, label: run.label, detail: { ip: req.ip, size: req.raw.length }, traceId: req.traceId ?? null });
    await this.delivered(w, { outcome: 'accepted', status: 202, reason: null, runId: run.id, size: req.raw.length });
    return { run: run.id };
  }

  private audit(p: Principal, ctx: Ctx, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: ctx.traceId ?? null });
  }
}
