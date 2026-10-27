import { actorFrom } from '../audit/chain.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Label } from '../authz/labels.js';
import { workspacesFor } from '../http/middleware.js';
import { HttpProblem, conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { HOOK_MAX_BYTES, HOOK_SIGNING, SignedHooks, type SignedRequest } from '../workflows/signed-hooks.js';
import { webhookInput } from './flow-integrations.js';
import type { FlowRow } from './flows.js';
import type { Actor, AppRow, AppService } from './service.js';

/*
 * Incoming webhooks of app flows (migration 082_app_flow_integration). A flow whose trigger is `webhook` is started
 * by a signed POST to `/hooks/apps/<tenant>/<flowId>` (outside `/api`, no session):
 *
 * - The body is JSON, at most HOOK_MAX_BYTES. `X-Exprsn-Timestamp` is the sending time in Unix seconds and
 *   `X-Exprsn-Signature` is `sha256=<hex>`, the HMAC-SHA256 under the flow's secret of `<timestamp>.<raw body>`: the
 *   timestamp is signed with the body, so an old request cannot be sent again with a fresh time.
 * - A timestamp more than HOOK_WINDOW_SECONDS from now is refused; a signature seen before (kept in
 *   `app_flow_hook_nonces` for twice the window, across instances) is a replay and refused.
 * - The secret is 32 random bytes, shown once when it is made or rotated, and stored sealed under the tenant key with
 *   the flow's id as associated data. Rotating replaces it at once: the old secret stops working.
 * - The hook is off until a designer turns it on (who then owns its runs, as the owner of an app trigger does, and is
 *   checked again at every request: active, may run workflows and read records, still in the workflow's workspace).
 *   The flow itself must be enabled too.
 * - Every request is rate-limited per flow (HOOK_RATE_PER_MINUTE) before the signature is checked.
 * - The verified payload passes the `untrusted-content` and `user-input` checkpoints at the flow's label before a
 *   run exists, so no model step sees text the content rules refuse; a redaction carries on only when the redacted
 *   text is still a JSON object.
 * - The run carries the flow's label (the entity's), like the flow's other runs. Accepted and refused requests are
 *   audited (`app.flow.hook.received`, `app.flow.hook.refused`); a request for a flow that does not exist is not.
 *
 * 1.8.0 (B-130): the signature, window, replay, size, rate and content checks are `workflows/signed-hooks.ts`, which
 * every workflow's webhook trigger (`workflows/hooks.ts`) shares; this module keeps the flow's rows, owner rules
 * and audit actions.
 */

export { HOOK_MAX_BYTES, HOOK_RATE_PER_MINUTE, HOOK_WINDOW_SECONDS, SIGNATURE_HEADER, TIMESTAMP_HEADER, signHook } from '../workflows/signed-hooks.js';

const aad = (flowId: string) => `appflowhook:${flowId}`;

export interface HookRequest extends SignedRequest {
  tenant: string;
  flowId: string;
}

export class AppFlowHooks {
  private readonly core: SignedHooks;

  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {
    this.core = new SignedHooks(s, 'app-flow-hook');
  }

  private get db() {
    return this.s().db;
  }

  /** The hook's public path and full URL for a flow. */
  async address(tenantId: string, flowId: string): Promise<{ path: string; url: string }> {
    const t = await this.s().tenants.byId(tenantId);
    const path = `/hooks/apps/${t?.slug ?? tenantId}/${flowId}`;
    return { path, url: `${this.s().cfg.PUBLIC_URL.replace(/\/+$/, '')}${path}` };
  }

  async view(r: FlowRow) {
    return { enabled: !!r.hook_enabled, secretSet: !!r.hook_secret, secretSetAt: r.hook_secret_at ?? null, owner: r.hook_owner ?? null, ...(await this.address(r.tenant_id, r.id)), ...HOOK_SIGNING };
  }

  private async flowOf(p: Principal, appRef: string, ref: string): Promise<{ app: AppRow; row: FlowRow }> {
    const app = await this.apps.designable(p, appRef);
    const r = (await this.db('app_flows').where({ app_id: app.id }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Flow');
    const row = { ...(r as unknown as FlowRow), enabled: !!r.enabled, hook_enabled: !!r.hook_enabled, hook_secret_at: r.hook_secret_at == null ? null : Number(r.hook_secret_at) };
    const model = JSON.parse(String(row.model)) as { trigger: { kind: string } };
    if (model.trigger.kind !== 'webhook') throw new HttpProblem(409, 'Not a webhook flow', `${row.name} starts ${model.trigger.kind === 'manual' ? 'by hand' : `on its ${model.trigger.kind} trigger`}; make its trigger a webhook first.`);
    if (row.workspace_id && p.workspaceId !== row.workspace_id && !(await workspacesFor(this.s(), p)).some((w) => w.id === row.workspace_id)) throw new HttpProblem(403, 'Forbidden', "The flow's workflow lives in a workspace you are not a member of.", { extensions: { step: 'workspace' } });
    return { app, row };
  }

  /** Makes or replaces the flow's secret; the secret is in this answer only. */
  async rotate(actor: Actor & { principal: Principal }, appRef: string, ref: string) {
    const { app, row } = await this.flowOf(actor.principal, appRef, ref);
    // Signatures made with the old secret are no use any more; the core forgets the ones seen.
    const { secret, sealed, at: t } = await this.core.make(row.tenant_id, row.id, aad(row.id));
    await this.db('app_flows').where({ id: row.id }).update({ hook_secret: sealed, hook_secret_at: t, updated_at: t, updated_by: actor.principal.userId });
    await this.audit(actor, 'app.flow.hook.rotated', { app: app.id, flow: row.id }, app.label, { first: !row.hook_secret, enabled: !!row.hook_enabled });
    return { secret, secretSetAt: t, enabled: !!row.hook_enabled, ...(await this.address(row.tenant_id, row.id)) };
  }

  /** Turns the hook on (the caller becomes its owner) or off. */
  async setEnabled(actor: Actor & { principal: Principal }, appRef: string, ref: string, enabled: boolean) {
    const p = actor.principal;
    const { app, row } = await this.flowOf(p, appRef, ref);
    if (enabled && !row.hook_secret) throw conflict('Make the webhook secret first (Rotate secret): a hook without a secret cannot verify anything.');
    if (enabled && !authorize(p, 'agents:run').allow) throw new HttpProblem(403, 'Forbidden', 'The owner of a webhook runs its flow and needs agents:run.');
    await this.db('app_flows').where({ id: row.id }).update({ hook_enabled: enabled, ...(enabled ? { hook_owner: p.userId } : {}), updated_at: Date.now(), updated_by: p.userId });
    await this.audit(actor, 'app.flow.hook.updated', { app: app.id, flow: row.id }, app.label, { enabled, ...(enabled ? { owner: p.userId } : {}) });
    return this.view({ ...row, hook_enabled: enabled, hook_owner: enabled ? p.userId : (row.hook_owner ?? null) });
  }

  // ---------- the public endpoint ----------

  private async refused(row: FlowRow, req: HookRequest, status: number, title: string, reason: string, detail: string, label: Label = 'internal'): Promise<never> {
    await this.s().audit.append({ tenantId: row.tenant_id, action: 'app.flow.hook.refused', kind: 'system', actor: { service: 'apps.hooks', ...(row.hook_owner ? { user: row.hook_owner } : {}) }, target: { app: row.app_id, flow: row.id, workflow: row.workflow_id }, label, detail: { reason, ip: req.ip, size: req.raw.length }, traceId: req.traceId ?? null });
    throw new HttpProblem(status, title, detail);
  }

  /** A body over the limit, refused before it is read in full (audited when the flow exists). */
  async oversize(req: Omit<HookRequest, 'raw'>): Promise<never> {
    const row = await this.locate(req.tenant, req.flowId).catch(() => null);
    const problem = new HttpProblem(413, 'Payload too large', `A webhook body is at most ${HOOK_MAX_BYTES} bytes.`);
    if (row) await this.refused(row, { ...req, raw: Buffer.alloc(0) }, 413, problem.title, 'oversize', problem.detail ?? '').catch(() => undefined);
    throw problem;
  }

  private async locate(tenant: string, flowId: string): Promise<FlowRow> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(flowId)) throw notFound('Webhook');
    const t = await this.s().tenants.bySlug(tenant);
    if (!t || t.state !== 'active') throw notFound('Webhook');
    const r = (await this.db('app_flows').where({ id: flowId, tenant_id: t.id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Webhook');
    return { ...(r as unknown as FlowRow), enabled: !!r.enabled, hook_enabled: !!r.hook_enabled };
  }

  /** The owner as a principal now, in the workflow's workspace, or why the hook cannot start anything. */
  private owner(row: FlowRow): Promise<Principal | string> {
    return this.core.owner(row.tenant_id, row.hook_owner, row.workspace_id ?? null, [
      ['agents:run', 'the owner may no longer run workflows'],
      ['records:read', 'the owner may no longer read records']
    ]);
  }

  async receive(req: HookRequest): Promise<{ run: string }> {
    const s = this.s();
    const row = await this.locate(req.tenant, req.flowId);
    await this.core.limit(row.id);
    const refuse = (status: number, title: string, reason: string, detail: string, label?: Label) => this.refused(row, req, status, title, reason, detail, label);
    const model = JSON.parse(String(row.model)) as { trigger: { kind: string } };
    if (model.trigger.kind !== 'webhook' || !row.enabled || !row.hook_enabled || !row.hook_secret) {
      // The caller learns no more than for a flow that does not exist.
      await refuse(404, 'Not found', 'disabled', 'Webhook not found.');
    }
    const payload = await this.core.verify({ key: row.id, tenantId: row.tenant_id, sealedSecret: row.hook_secret!, aad: aad(row.id) }, req, refuse);
    const p = await this.owner(row);
    if (typeof p === 'string') await refuse(409, 'Cannot start', 'owner', `The flow cannot start: ${p}.`);
    const owner = p as Principal;
    const w = (await this.db('workflows').where({ id: row.workflow_id, tenant_id: row.tenant_id }).first('label')) as { label: Label } | undefined;
    if (!w) await refuse(409, 'Cannot start', 'workflow gone', "The flow's workflow is gone.");
    const label = w!.label;
    const screened = await this.core.screen({ tenantId: row.tenant_id, principal: owner, label, source: { kind: 'app-flow-hook', id: row.id }, meta: { flow: row.id, workflow: row.workflow_id } }, payload, refuse);
    const app = (await this.db('apps').where({ id: row.app_id }).first('name')) as { name: string };
    const entity = await this.apps.entityById(row.tenant_id, row.entity_id);
    const input = webhookInput(app, entity ?? { name: '' }, row, screened);
    let run: { id: string; label: Label };
    try {
      run = await s.workflows.start(owner, row.workflow_id, { input, dry: false, trigger: 'webhook' });
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) return this.refused(row, req, 409, 'Cannot start', 'start refused', `The flow cannot start: ${err.detail ?? err.title}`, label);
      throw err;
    }
    await s.audit.append({ tenantId: row.tenant_id, action: 'app.flow.hook.received', kind: 'system', actor: { service: 'apps.hooks', user: owner.userId }, target: { app: row.app_id, flow: row.id, workflow: row.workflow_id, run: run.id }, label: run.label, detail: { ip: req.ip, size: req.raw.length }, traceId: req.traceId ?? null });
    return { run: run.id };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}

