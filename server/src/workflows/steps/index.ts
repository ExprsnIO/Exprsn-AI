import { clears, type Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import { sha256 } from '../../crypto/index.js';
import { HttpProblem } from '../../http/problem.js';
import { HostRefused } from '../../mcp/hosts.js';
import type { Values } from '../../apps/schema.js';
import type { Services } from '../../services.js';
import { render, renderText, type TemplateScope, type WfGraph, type WfNode } from '../graph.js';
import { approvalFormSchema, endpointProblem, notifyConfig, webhookConfig, type ApprovalForm } from './configs.js';

/*
 * Sprint 32c step runtimes (B-3907 approval forms, B-3908 notify and webhook). The workflow service owns runs,
 * checkpoints and approvals; it calls this kit for what these steps do, installed with `useStepKit` once the services
 * exist (the steps reach the notifications, the webhook path and the app forms).
 *
 * - notify: in-app notices (and email, when asked) to the people a step names and the holders of its roles. Only
 *   active users of the tenant cleared for the step's label are told, and in a workspace with members-only visibility
 *   only its members; anyone else is skipped and counted. Audited as `workflow.step.notified`.
 * - webhook: one delivery through the tenant's webhook path: a webhook managed for the workflow and endpoint
 *   (`workflow:<id>:<hash>`, no subscriptions of its own), signed with the tenant's Ed25519 webhook key (receivers
 *   verify against the tenant's JWKS), retried with the breaker. The endpoint is checked against the operator's and
 *   the tenant's outbound host rules when the graph is saved (an out-of-list host is refused there, naming the step)
 *   and again when the step runs. Audited as `workflow.step.webhook`.
 * - approval forms: the form is resolved as the run's owner when the approval opens (its app and form ids are kept
 *   with the approval); the approver's answers are validated like a submission and become the step's output.
 */

/** What a notify or webhook step runs with (from the workflow service). */
export interface StepRun {
  run: { id: string; tenant_id: string; workspace_id: string | null; workflow_id: string; created_by: string; label: Label };
  node: WfNode;
  principal: Principal;
  label: Label;
  scope: TemplateScope;
  merged: Record<string, unknown>;
}

/** The form an approval asks for, as kept with the approval row. */
export interface StoredForm {
  appId: string;
  formId: string;
  app: string;
  form: string;
}

export type StepResult = { output: Record<string, unknown>; detail: Record<string, unknown> };

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The webhook a workflow's step delivers through: one per workflow and endpoint. */
export const workflowHookName = (workflowId: string, url: string): string => `workflow:${workflowId}:${sha256(url).slice(0, 8)}`;

/** Thrown when a graph cannot be saved: the route answers 422 with the issues, as publishing does. */
function refused(issues: { code: string; nodeId: string; message: string }[]): HttpProblem {
  return new HttpProblem(422, 'Workflow invalid', `Saving failed: ${issues[0]!.message}${issues.length > 1 ? ` (${issues.length - 1} more)` : ''}`, { extensions: { errors: issues, warnings: [] } });
}

export class WorkflowStepKit {
  constructor(private readonly s: () => Services) {}

  // ---------- save-time checks ----------

  /**
   * At save (create, draft save, publish): every webhook step's endpoint passes the outbound host rules (the
   * operator's and the tenant's allowed hosts), and every approval form exists and is readable by the person saving.
   */
  async checkSave(p: Principal, g: WfGraph): Promise<void> {
    const issues: { code: string; nodeId: string; message: string }[] = [];
    for (const n of g.nodes) {
      if (n.kind === 'webhook') {
        const cfg = webhookConfig.safeParse(n.config);
        if (!cfg.success || endpointProblem(cfg.data.url)) continue; // reported by validation
        try {
          await this.s().webhooks.checkEndpoint(p.tenantId, cfg.data.url);
        } catch (err) {
          if (err instanceof HostRefused) issues.push({ code: 'config', nodeId: n.id, message: `${n.title}: the endpoint is refused by the outbound host rules: ${err.message}` });
          else throw err;
        }
      }
      if (n.kind === 'approval' && n.config.form !== undefined) {
        const f = approvalFormSchema.safeParse(n.config.form);
        if (!f.success) continue;
        try {
          await this.s().apps.forms.form(p, f.data.app, f.data.form);
        } catch (err) {
          if (err instanceof HttpProblem && (err.status === 404 || err.status === 403)) issues.push({ code: 'reference', nodeId: n.id, message: `${n.title}: there is no form ${f.data.form} in app ${f.data.app} that you can open.` });
          else throw err;
        }
      }
    }
    if (issues.length) throw refused(issues);
  }

  /** The webhooks a deleted workflow delivered through go with it. */
  async removed(tenantId: string, workflowId: string): Promise<number> {
    const s = this.s();
    const rows = (await s.db('webhooks').where({ tenant_id: tenantId }).andWhere('name', 'like', `workflow:${workflowId}:%`).select('id')) as { id: string }[];
    for (const r of rows) await s.webhooks.remove(tenantId, r.id);
    return rows.length;
  }

  // ---------- notify ----------

  async notify(c: StepRun): Promise<StepResult> {
    const s = this.s();
    const cfg = notifyConfig.parse(c.node.config);
    const tenantId = c.run.tenant_id;
    const named = new Set<string>();
    for (const t of cfg.users) {
      const v = render(t, c.scope);
      for (const x of Array.isArray(v) ? v : [v]) if (x != null && String(x).trim()) named.add(String(x).trim().slice(0, 200));
    }
    const ids = [...named].filter((x) => ULID.test(x));
    const usernames = [...named].filter((x) => !ULID.test(x));
    const byName = usernames.length ? ((await s.db('users').where({ tenant_id: tenantId }).whereIn('username', usernames).select('id', 'username')) as { id: string; username: string }[]) : [];
    const wanted = new Set<string>([...ids, ...byName.map((u) => u.id), ...(cfg.roles.length ? await s.notifications.usersWithRoles(tenantId, cfg.roles) : [])]);
    const unknown = usernames.length - byName.length;
    const rows = wanted.size ? ((await s.db('users').where({ tenant_id: tenantId, state: 'active' }).whereIn('id', [...wanted]).select('id', 'clearance')) as { id: string; clearance: Label }[]) : [];
    let cleared = rows.filter((u) => clears(u.clearance, c.label)).map((u) => u.id);
    if (c.run.workspace_id && cleared.length) {
      const ws = (await s.db('workspaces').where({ id: c.run.workspace_id }).first('visibility')) as { visibility: string } | undefined;
      if (ws?.visibility !== 'tenant') {
        const members = new Set(((await s.db('workspace_members').where({ workspace_id: c.run.workspace_id }).whereIn('user_id', cleared).select('user_id')) as { user_id: string }[]).map((m) => m.user_id));
        cleared = cleared.filter((u) => members.has(u));
      }
    }
    const skipped = wanted.size - cleared.length + unknown;
    const title = renderText(cfg.title, c.scope).slice(0, 200);
    const body = renderText(cfg.body, c.scope).slice(0, 1000);
    const sent = await s.notifications.notify({ tenantId, userIds: cleared, kind: 'workflow', title, ...(body ? { body } : {}), route: cfg.route ?? `workflows?run=${c.run.id}`, label: c.label, email: cfg.email });
    await s.audit.append({ tenantId, action: 'workflow.step.notified', kind: 'system', actor: { service: 'workflows', user: c.run.created_by }, target: { workflow: c.run.workflow_id, run: c.run.id, node: c.node.id }, label: c.label, detail: { notified: sent.length, skipped, email: cfg.email, roles: cfg.roles } });
    return { output: { notified: sent.length, skipped }, detail: { notified: sent.length, skipped, email: cfg.email } };
  }

  // ---------- webhook ----------

  async webhook(c: StepRun): Promise<StepResult> {
    const s = this.s();
    const cfg = webhookConfig.parse(c.node.config);
    const problem = endpointProblem(cfg.url);
    if (problem) throw new Error(`${c.node.title}: ${problem}`);
    let data: Record<string, unknown>;
    if (cfg.body === undefined) data = c.merged;
    else if (typeof cfg.body === 'string') {
      let v = render(cfg.body, c.scope);
      if (typeof v === 'string') {
        try {
          v = JSON.parse(v);
        } catch {
          throw new Error('The body template does not render to a JSON object.');
        }
      }
      if (!isObject(v)) throw new Error('The body template does not render to a JSON object.');
      data = v;
    } else data = Object.fromEntries(Object.entries(cfg.body).map(([k, t]) => [k, render(t, c.scope)]));
    let hook;
    try {
      hook = await s.webhooks.managed(c.run.tenant_id, 'workflow', cfg.url, c.run.label, workflowHookName(c.run.workflow_id, cfg.url));
    } catch (err) {
      if (err instanceof HostRefused) throw new Error(`The endpoint is refused by the outbound host rules: ${err.message}`, { cause: err });
      throw err;
    }
    // One delivery per run and step: a retried job finds it queued already (the delivery id is deduplicated).
    const eventId = `workflow-run:${c.run.id}:${c.node.id}`;
    const d = await s.webhooks.sendTo(hook, cfg.event, c.label, eventId, { workflow: c.run.workflow_id, run: c.run.id, step: c.node.id, data });
    const delivery = d?.id ?? ((await s.db('webhook_deliveries').where({ webhook_id: hook.id, event_id: eventId }).first('id')) as { id: string } | undefined)?.id ?? null;
    const host = new URL(cfg.url).host;
    await s.audit.append({ tenantId: c.run.tenant_id, action: 'workflow.step.webhook', kind: 'system', actor: { service: 'workflows', user: c.run.created_by }, target: { workflow: c.run.workflow_id, run: c.run.id, node: c.node.id, webhook: hook.id }, label: c.label, detail: { host, event: cfg.event, delivery } });
    return { output: { webhook: hook.id, delivery, event: cfg.event }, detail: { host, event: cfg.event, delivery } };
  }

  // ---------- approval forms ----------

  /** The form an approval opens with, resolved as the run's owner (who must be able to open it). */
  async resolveForm(p: Principal, ref: ApprovalForm): Promise<StoredForm> {
    const { app, form } = await this.s().apps.forms.form(p, ref.app, ref.form);
    return { appId: app.id, formId: form.id, app: app.name, form: form.name };
  }

  /** The form as the approver sees it: its fields with types, options and conditions. */
  async describeForm(tenantId: string, stored: StoredForm): Promise<Record<string, unknown> | null> {
    const f = await this.s().apps.forms.byId(tenantId, stored.formId);
    if (!f) return null;
    return { app: f.app.name, form: f.form.name, ...this.s().apps.forms.describe(f.entity, f.form) };
  }

  /** The approver's answers, validated like a submission (nothing is written). */
  async answers(p: Principal, tenantId: string, stored: StoredForm, input: Values, ip: string | null): Promise<{ values: Values; dropped: string[] }> {
    const f = await this.s().apps.forms.byId(tenantId, stored.formId);
    if (!f) throw new HttpProblem(409, 'Conflict', `The form ${stored.form} of ${stored.app} no longer exists; reject the step or ask an admin.`);
    return this.s().apps.forms.validateAnswers({ principal: p, source: 'workflow', ip, service: 'workflows' }, f.app, f.entity, f.form, input);
  }
}
