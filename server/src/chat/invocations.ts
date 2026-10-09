import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import type { ResolvedTool, ToolOutcome } from '../registry/dispatch.js';
import type { EntryRow, SideEffect } from '../registry/service.js';
import { skillClosure } from '../registry/skills.js';
import type { Services } from '../services.js';
import { normalizePlan, type Plan } from '../thinking/service.js';
import type { ConversationRow } from './service.js';
import type { Chunk } from './streams.js';

/*
 * 1.7.0, Sprint 40a (B-4001 to B-4009): agents, tools, skills and workflows called from a conversation.
 *
 * What a conversation may call (`capabilities`) is decided where chat already decides it: the profile's tool list
 * resolved through the dispatcher at the conversation's label (an entry whose ceiling is below the conversation's
 * data is never listed, and calling it by name is refused the same way), the published agents the caller may run
 * within the conversation's ceiling (the profile's own list is what the model is offered), the published skills (the
 * profile's allow-list when it has one), and the published workflows of the workspace.
 *
 * Every call is a `chat_invocations` row, the card the Chat screen shows. A tool call from the composer goes through
 * the dispatcher like a model's call: the tool-call guardrail may hold it (a reviewer decides in the Flags queue); a
 * write tool waits for the owner's own approval on an in-chat card; a destructive or `confirm: always` tool also
 * needs the guardrail's approver when a rule says so. What ran joins the conversation as a tool turn (a message with
 * `turn: tool`) that the model sees next. `@agent` starts a run bound to the conversation with an answer turn
 * attributed to the agent; `/workflow` starts a published workflow whose approvals are cards in the conversation.
 * Skills added with `+skill` ride on the conversation (sticky, or for one turn) into the system prompt.
 */

export type InvocationKind = 'tool' | 'agent' | 'workflow' | 'plan';
export type InvocationState = 'awaiting' | 'held' | 'running' | 'done' | 'failed' | 'denied' | 'expired' | 'cancelled';

export interface InvocationRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  user_id: string;
  kind: InvocationKind;
  name: string;
  entry_id: string | null;
  version: string | null;
  side_effect: SideEffect | null;
  proposed_by: 'user' | 'model';
  arguments: string | null;
  state: InvocationState;
  approval: 'owner' | 'reviewer' | 'owner+reviewer' | null;
  decided_by: string | null;
  decided_at: number | null;
  expires_at: number | null;
  run_kind: 'agent-run' | 'workflow-run' | null;
  run_id: string | null;
  chain_id: string | null;
  message_id: string | null;
  answer_id: string | null;
  flag_id: string | null;
  result: string | null;
  error: string | null;
  label: Label;
  created_at: number;
  updated_at: number;
}

export interface ConversationSkill {
  name: string;
  mode: 'sticky' | 'once';
}

const ACTIVE: InvocationState[] = ['awaiting', 'held', 'running'];

export class ChatInvocations {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private seal(tenantId: string, id: string, field: string, value: unknown): Promise<string> {
    return this.s().keys.seal(tenantId, JSON.stringify(value ?? null), `chat-invocation:${id}:${field}`);
  }

  private async open<T>(tenantId: string, id: string, field: string, sealed: string | null, fallback: T): Promise<T> {
    if (!sealed) return fallback;
    try {
      return JSON.parse(await this.s().keys.open(tenantId, sealed, `chat-invocation:${id}:${field}`)) as T;
    } catch {
      return fallback;
    }
  }

  private async row(tenantId: string, id: string): Promise<InvocationRow> {
    const r = (await this.db('chat_invocations').where({ tenant_id: tenantId, id }).first()) as InvocationRow | undefined;
    if (!r) throw notFound('Invocation');
    return r;
  }

  private emit(c: Pick<ConversationRow, 'user_id' | 'tenant_id' | 'id'>, event: string, data: Record<string, unknown>): void {
    this.s().bus.publish(TOPICS.chatEvent, { userId: c.user_id, tenantId: c.tenant_id, event, data: { conversationId: c.id, ...data } });
  }

  // ---------- B-4001: what a conversation may call ----------

  /** The conversation's profile, resolved for its label (the head answer's profile, else the conversation's). */
  private async profileOf(p: Principal, c: ConversationRow) {
    const s = this.s();
    const id = c.profile_id;
    if (!id) throw conflict('This conversation has no profile yet; send a message first.');
    return s.chat.resolveProfileFor(p, id, c.label);
  }

  async capabilities(p: Principal, conversationId: string) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    const perms = effectivePermissions(p);
    const out: {
      label: Label;
      profile: string | null;
      tools: { name: string; version: string; description: string | null; inputSchema: Record<string, unknown> | null; sideEffect: SideEffect; confirm: 'always' | 'never'; label: Label; impl: string; warning: string | null }[];
      hidden: { name: string; reason: string }[];
      agents: { name: string; version: string; description: string | null; label: Label; inputSchema: Record<string, unknown> | null; offeredToModel: boolean }[];
      skills: { name: string; version: string; description: string | null; label: Label; active: 'sticky' | 'once' | null }[];
      workflows: { id: string; name: string; description: string | null; label: Label; inputSchema: Record<string, unknown> | null }[];
      active: ConversationSkill[];
    } = { label: c.label, profile: null, tools: [], hidden: [], agents: [], skills: [], workflows: [], active: this.skillsOf(c) };
    let profileTools: string[] = [];
    let profileAgents: string[] = [];
    let profileSkills: string[] | null = null;
    if (c.profile_id) {
      try {
        const r = await this.profileOf(p, c);
        out.profile = r.profile.name;
        profileTools = r.profile.tools.filter((t) => t !== 'calculate');
        profileAgents = r.profile.agents ?? [];
        profileSkills = r.profile.skills ?? null;
        if (r.profile.tools.includes('calculate')) out.tools.push({ name: 'calculate', version: 'built-in', description: 'Exact arithmetic by the calculation worker.', inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }, sideEffect: 'read', confirm: 'never', label: 'public', impl: 'builtin', warning: null });
      } catch {
        out.profile = null;
      }
    }
    if (s.tools && profileTools.length && perms.has('tools:invoke')) {
      const r = await s.tools.resolve(p, profileTools, c.label);
      for (const t of r.tools) out.tools.push({ name: t.entry.name, version: t.entry.version, description: t.entry.description, inputSchema: t.entry.input_schema ?? null, sideEffect: t.sideEffect, confirm: t.confirm, label: t.entry.label, impl: t.entry.impl, warning: t.warning });
      out.hidden.push(...r.hidden);
    }
    if (perms.has('agents:run')) {
      for (const a of await s.agents.runnable(p)) {
        if (labelRank(c.label) > labelRank(a.label)) {
          out.hidden.push({ name: `agent:${a.name}`, reason: `its ceiling is ${a.label}; the conversation is ${c.label}` });
          continue;
        }
        const e = await s.registry.get(p.tenantId, a.id);
        out.agents.push({ name: a.name, version: a.version, description: a.description, label: a.label, inputSchema: e?.input_schema ?? null, offeredToModel: profileAgents.includes(a.name) });
      }
    }
    const seen = new Set<string>();
    for (const e of await s.registry.list(p.tenantId, { kind: 'skill' })) {
      if (!(e.status === 'published' || e.status === 'deprecated') || !s.registry.visibleTo(e, p) || seen.has(e.name)) continue;
      seen.add(e.name);
      if (profileSkills && !profileSkills.includes(e.name)) continue;
      if (labelRank(c.label) > labelRank(e.label)) {
        out.hidden.push({ name: `skill:${e.name}`, reason: `its ceiling is ${e.label}; the conversation is ${c.label}` });
        continue;
      }
      out.skills.push({ name: e.name, version: e.version, description: e.description, label: e.label, active: out.active.find((x) => x.name === e.name)?.mode ?? null });
    }
    if (perms.has('agents:run')) {
      for (const w of await s.workflows.list(p)) {
        if (!w.publishedVersion) continue;
        if (labelRank(c.label) > labelRank(w.label)) {
          out.hidden.push({ name: `workflow:${w.name}`, reason: `its ceiling is ${w.label}; the conversation is ${c.label}` });
          continue;
        }
        const callee = await s.workflows.asCallee(p, w.name);
        out.workflows.push({ id: w.id, name: w.name, description: w.description, label: w.label, inputSchema: 'missing' in callee ? null : (callee.input_schema ?? null) });
      }
    }
    return out;
  }

  // ---------- B-4002, B-4003: a person calls a tool; write tools behind a card ----------

  private async resolveTool(p: Principal, c: ConversationRow, name: string): Promise<ResolvedTool> {
    const s = this.s();
    const r = await this.profileOf(p, c);
    if (!r.profile.tools.includes(name)) throw forbidden(`${name} is not on profile ${r.profile.name}'s tool list.`, { step: 'role' });
    if (!s.tools) throw conflict('Tools cannot be called on this instance.');
    const res = await s.tools.resolve(p, [name], c.label);
    const t = res.tools[0];
    if (!t) {
      const why = res.hidden[0]?.reason ?? 'not available';
      throw new HttpProblem(409, 'Tool unavailable', `${name} cannot be called here: ${why}.`, { extensions: { step: 'zone', reason: why } });
    }
    return t;
  }

  /** B-4002: the profile's model turns free text into the tool's arguments (one gateway call with the tool offered). */
  private async argumentsFromText(p: Principal, c: ConversationRow, tool: ResolvedTool, text: string): Promise<Record<string, unknown>> {
    const r = await this.profileOf(p, c);
    const args = await this.s().chat.toolArgumentsFromText(p, c, r, tool, text);
    if (!args) throw new HttpProblem(422, 'Arguments unclear', `${r.profile.name}'s model could not turn that into arguments for ${tool.entry.name}. Fill the form instead.`);
    return args;
  }

  async callTool(p: Principal, conversationId: string, input: { name: string; arguments?: Record<string, unknown>; text?: string }) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.kind !== 'chat') throw conflict('Tools are called from a chat, not a comparison.');
    if (c.user_id !== p.userId) throw forbidden('Only the conversation\'s owner calls tools in it.', { step: 'role' });
    const tool = await this.resolveTool(p, c, input.name);
    const args = input.arguments ?? (input.text ? await this.argumentsFromText(p, c, tool, input.text) : {});
    const id = ulid();
    const t = Date.now();
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: p.userId, kind: 'tool', name: tool.entry.name, entry_id: tool.entry.id, version: tool.entry.version, side_effect: tool.sideEffect, proposed_by: 'user',
      arguments: await this.seal(c.tenant_id, id, 'arguments', args), state: 'running', approval: null, decided_by: null, decided_at: null, expires_at: null, run_kind: null, run_id: null, chain_id: null, message_id: null, answer_id: null, flag_id: null,
      result: null, error: null, label: c.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.requested', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: id, tool: tool.entry.name, version: tool.entry.version }, label: c.label, detail: { sideEffect: tool.sideEffect, confirm: tool.confirm, by: 'user' } });
    return this.attempt(p, c, row, tool, args, false);
  }

  /**
   * B-4003: the model proposed a write (or destructive, or `confirm: always`) call during an answer; the dispatcher
   * held it. The card waits for the owner; the model is told to carry on without the result.
   */
  async proposeFromModel(p: Principal, c: ConversationRow, answerId: string, tool: ResolvedTool, args: Record<string, unknown>, o: ToolOutcome): Promise<InvocationRow> {
    const s = this.s();
    const id = ulid();
    const t = Date.now();
    const approval = this.approvalFor(tool, o);
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: c.user_id, kind: 'tool', name: tool.entry.name, entry_id: tool.entry.id, version: tool.entry.version, side_effect: tool.sideEffect, proposed_by: 'model',
      arguments: await this.seal(c.tenant_id, id, 'arguments', args), state: approval === 'reviewer' ? 'held' : 'awaiting', approval, decided_by: null, decided_at: null, expires_at: t + s.cfg.CHAT_CARD_TTL_SECONDS * 1000, run_kind: null, run_id: null, chain_id: null, message_id: null, answer_id: answerId, flag_id: null,
      result: null, error: null, label: c.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.proposed', kind: 'system', actor: { service: 'chat', user: c.user_id }, target: { conversation: c.id, invocation: id, tool: tool.entry.name, version: tool.entry.version, message: answerId }, label: c.label, detail: { sideEffect: tool.sideEffect, approval, decision: o.decision } });
    if (approval === 'reviewer') await this.fileHold(p, c, row, args, o.error ?? null);
    this.emit(c, 'chat.invocation', { invocationId: id, state: row.state, kind: 'tool', name: tool.entry.name });
    return row;
  }

  /** Who must approve a held call: the owner for a write tool; a reviewer when the guardrail held it; both for a destructive or always-confirm tool the guardrail also flagged. */
  private approvalFor(tool: ResolvedTool, o: ToolOutcome): NonNullable<InvocationRow['approval']> {
    const byRule = o.decision === 'require-approval';
    if (tool.sideEffect === 'read' && tool.confirm !== 'always') return 'reviewer';
    if ((tool.sideEffect === 'destructive' || tool.confirm === 'always') && byRule) return 'owner+reviewer';
    return 'owner';
  }

  /** Runs the call once (not approved), then cards or holds it, or records the turn. */
  private async attempt(p: Principal, c: ConversationRow, row: InvocationRow, tool: ResolvedTool, args: Record<string, unknown>, approved: boolean) {
    const s = this.s();
    const o = await s.tools.call({ principal: p, label: c.label, source: { kind: 'message', id: row.message_id ?? row.id }, approved, chainRoot: { kind: 'chat-turn', ref: row.id } }, tool, args);
    if (o.needsApproval && !approved) {
      const approval = this.approvalFor(tool, o);
      const t = Date.now();
      await this.db('chat_invocations').where({ id: row.id }).update({ state: approval === 'reviewer' ? 'held' : 'awaiting', approval, expires_at: t + s.cfg.CHAT_CARD_TTL_SECONDS * 1000, error: o.error ?? null, updated_at: t });
      const after = { ...row, state: (approval === 'reviewer' ? 'held' : 'awaiting') as InvocationState, approval, expires_at: t + s.cfg.CHAT_CARD_TTL_SECONDS * 1000, error: o.error ?? null };
      await s.audit.append({ tenantId: c.tenant_id, action: approval === 'reviewer' ? 'chat.tool.held' : 'chat.tool.awaiting', kind: 'system', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, tool: tool.entry.name }, label: c.label, detail: { approval, decision: o.decision, reason: o.error ?? null } });
      if (approval === 'reviewer') await this.fileHold(p, c, after, args, o.error ?? null);
      this.emit(c, 'chat.invocation', { invocationId: row.id, state: after.state, kind: 'tool', name: tool.entry.name });
      return this.view(after, p);
    }
    return this.recordToolTurn(p, c, row, tool, args, o);
  }

  /** The call ran (or was refused): a tool turn joins the conversation and the card is done. */
  private async recordToolTurn(p: Principal, c: ConversationRow, row: InvocationRow, tool: ResolvedTool, args: Record<string, unknown>, o: ToolOutcome) {
    const s = this.s();
    const chunk: NonNullable<Chunk['tool']> = { name: tool.entry.name, expression: JSON.stringify(args), ...(o.ok ? { output: o.result } : { error: o.error ?? 'The tool failed.' }) };
    const state: InvocationState = o.ok ? 'done' : o.denied ? 'denied' : 'failed';
    const turn = await s.chat.appendTurn(c, {
      parentId: row.answer_id ?? c.head_id,
      turn: 'tool',
      name: tool.entry.name,
      invocationId: row.id,
      content: o.ok ? `Called ${tool.entry.name}.` : `${tool.entry.name} did not run: ${o.error ?? 'it failed.'}`,
      tools: [chunk],
      label: c.label,
      state: 'complete'
    });
    const t = Date.now();
    await this.db('chat_invocations').where({ id: row.id }).update({ state, message_id: turn.id, result: o.ok ? await this.seal(c.tenant_id, row.id, 'result', o.result) : null, error: o.ok ? null : (o.error ?? null), updated_at: t });
    await s.audit.append({ tenantId: c.tenant_id, action: o.ok ? 'chat.tool.called' : o.denied ? 'chat.tool.refused' : 'chat.tool.failed', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, tool: tool.entry.name, version: tool.entry.version, message: turn.id }, label: c.label, detail: { sideEffect: tool.sideEffect, decision: o.decision, durationMs: o.durationMs, ...(o.ok ? {} : { error: o.error ?? null }) } });
    this.emit(c, 'chat.invocation', { invocationId: row.id, state, kind: 'tool', name: tool.entry.name, messageId: turn.id });
    return this.view({ ...row, state, message_id: turn.id, error: o.ok ? null : (o.error ?? null) }, p, args);
  }

  /** A call the guardrail held goes to the Flags queue, where a reviewer cleared for its label decides. */
  private async fileHold(p: Principal, c: ConversationRow, row: InvocationRow, args: Record<string, unknown>, reason: string | null): Promise<void> {
    const s = this.s();
    if (!s.guard.flags) return;
    const flag = await s.guard.flags.create({
      tenantId: c.tenant_id,
      workspaceId: c.workspace_id,
      kind: 'hold',
      checkpoint: 'tool-call',
      ruleId: null,
      ruleName: 'Tool call held for review',
      setId: null,
      stage: 'enforce',
      action: 'require-approval',
      severity: row.side_effect === 'destructive' ? 'high' : 'medium',
      label: c.label,
      text: JSON.stringify({ tool: row.name, arguments: args }),
      span: null,
      note: reason ?? `A guardrail held the call of ${row.name} from a conversation for review.`,
      actor: { user: p.userId, name: p.displayName, via: 'chat' },
      source: { kind: 'chat-invocation', id: row.id },
      conversationId: c.id
    });
    await this.db('chat_invocations').where({ id: row.id }).update({ flag_id: flag.id, updated_at: Date.now() });
  }

  /** The held call's text for the reviewer (the flag view). */
  async heldText(tenantId: string, id: string): Promise<{ conversationId: string; state: string; content: string } | null> {
    const r = (await this.db('chat_invocations').where({ tenant_id: tenantId, id }).first()) as InvocationRow | undefined;
    if (!r) return null;
    const args = await this.open<Record<string, unknown>>(r.tenant_id, r.id, 'arguments', r.arguments, {});
    return { conversationId: r.conversation_id, state: r.state, content: `${r.name} ${JSON.stringify(args)}` };
  }

  /** B-4002: a reviewer's decision on a held call (from the Flags queue): approved runs it, rejected records it. */
  async resolveHold(reviewer: Principal, id: string, decision: 'approved' | 'rejected'): Promise<{ conversationId: string; state: InvocationState }> {
    const s = this.s();
    const row = await this.row(reviewer.tenantId, id);
    if (row.state !== 'held') throw conflict(`This call is ${row.state}.`);
    const owner = await s.chat.principalForOwner(row.tenant_id, row.user_id, null);
    const c = await s.chat.conversationRow(row.tenant_id, row.conversation_id);
    if (!owner || !c) throw conflict('The conversation or its owner no longer exists.');
    const t = Date.now();
    if (decision === 'rejected') {
      await this.db('chat_invocations').where({ id: row.id }).update({ state: 'denied', decided_by: reviewer.userId, decided_at: t, error: 'Rejected by a reviewer.', updated_at: t });
      await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.rejected', kind: 'admin', actor: actorFrom(reviewer), target: { conversation: c.id, invocation: row.id, tool: row.name }, label: c.label, detail: { by: 'reviewer' } });
      await this.recordDenied(owner, c, row, 'A reviewer rejected this call.');
      return { conversationId: c.id, state: 'denied' };
    }
    await this.db('chat_invocations').where({ id: row.id }).update({ decided_by: reviewer.userId, decided_at: t, state: 'running', updated_at: t });
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.approved', kind: 'admin', actor: actorFrom(reviewer), target: { conversation: c.id, invocation: row.id, tool: row.name }, label: c.label, detail: { by: 'reviewer' } });
    const tool = await this.resolveTool(owner, c, row.name);
    const args = await this.open<Record<string, unknown>>(row.tenant_id, row.id, 'arguments', row.arguments, {});
    const v = await this.attempt(owner, c, { ...row, state: 'running' }, tool, args, true);
    return { conversationId: c.id, state: v.state };
  }

  /** B-4003: the owner (or a tool admin) decides an in-chat card. Expired cards are recorded as such. */
  // ---------- 1.7.0 (B-11703): plan cards ----------

  /** The plan a plan-first profile drafted for an answer, shown as a card the person approves, edits or declines. */
  async createPlanCard(c: ConversationRow, answerId: string, plan: Plan, offered: string[]): Promise<InvocationRow> {
    const s = this.s();
    const id = ulid();
    const t = Date.now();
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: c.user_id, kind: 'plan', name: 'plan', entry_id: null, version: null, side_effect: null, proposed_by: 'model',
      arguments: await this.seal(c.tenant_id, id, 'arguments', { ...plan, offered }), state: 'awaiting', approval: 'owner', decided_by: null, decided_at: null, expires_at: t + s.cfg.CHAT_CARD_TTL_SECONDS * 1000, run_kind: null, run_id: null, chain_id: null, message_id: null, answer_id: answerId, flag_id: null,
      result: null, error: null, label: c.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.plan.proposed', kind: 'system', actor: { service: 'chat', user: c.user_id }, target: { conversation: c.id, invocation: id, message: answerId }, label: c.label, detail: { steps: plan.steps.length, tools: plan.tools } });
    this.emit(c, 'chat.invocation', { invocationId: id, state: 'awaiting', kind: 'plan', name: 'plan', messageId: answerId });
    return row;
  }

  /** The person's decision on a plan card: approved (as drafted or edited) the answer runs under it; declined, nothing runs. */
  private async decidePlan(p: Principal, c: ConversationRow, row: InvocationRow, decision: 'approve' | 'deny', steps?: { title: string; tools?: string[]; data?: string[] }[]) {
    const s = this.s();
    const t = Date.now();
    const stored = await this.open<(Plan & { offered?: string[] }) | null>(row.tenant_id, row.id, 'arguments', row.arguments, null);
    if (decision === 'deny') {
      await this.db('chat_invocations').where({ id: row.id }).update({ state: 'denied', decided_by: p.userId, decided_at: t, error: `Declined by ${p.displayName}.`, updated_at: t });
      await s.audit.append({ tenantId: c.tenant_id, action: 'chat.plan.declined', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, message: row.answer_id }, label: c.label });
      this.emit(c, 'chat.invocation', { invocationId: row.id, state: 'denied', kind: 'plan', name: 'plan', messageId: row.answer_id });
      if (row.answer_id) await s.chat.runPlan(c.tenant_id, row.answer_id, 'deny', null, `${p.displayName} declined the plan.`);
      return this.view({ ...row, state: 'denied', decided_by: p.userId, decided_at: t }, p, (stored ?? undefined) as Record<string, unknown> | undefined);
    }
    const edited = !!steps;
    const plan: Plan = steps ? normalizePlan({ steps }, s.cfg.THINKING_PLAN_MAX_STEPS) : stored ? { steps: stored.steps, tools: stored.tools } : { steps: [], tools: [] };
    if (!plan.steps.length) throw conflict('This plan has no steps to approve.');
    const offered = stored?.offered ?? [];
    const unknown = plan.tools.filter((x) => offered.length && !offered.includes(x));
    if (unknown.length) throw badRequest(`The plan names tools this conversation cannot call: ${unknown.join(', ')}.`);
    const args = { ...plan, offered, edited };
    await this.db('chat_invocations').where({ id: row.id }).update({ state: 'done', decided_by: p.userId, decided_at: t, arguments: await this.seal(c.tenant_id, row.id, 'arguments', args), updated_at: t });
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.plan.approved', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, message: row.answer_id }, label: c.label, detail: { edited, steps: plan.steps.length, tools: plan.tools } });
    this.emit(c, 'chat.invocation', { invocationId: row.id, state: 'done', kind: 'plan', name: 'plan', messageId: row.answer_id });
    if (row.answer_id) await s.chat.runPlan(c.tenant_id, row.answer_id, 'approve', plan, null);
    return this.view({ ...row, state: 'done', decided_by: p.userId, decided_at: t }, p, args as unknown as Record<string, unknown>);
  }

  async decide(p: Principal, conversationId: string, id: string, decision: 'approve' | 'deny', steps?: { title: string; tools?: string[]; data?: string[] }[]) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    const row = await this.row(c.tenant_id, id);
    if (row.conversation_id !== c.id) throw notFound('Invocation');
    if (row.kind === 'plan') {
      if (row.user_id !== p.userId && !effectivePermissions(p).has('tools:manage')) throw forbidden('Only the conversation\'s owner or a tool admin decides this plan.', { step: 'role' });
      if (row.state !== 'awaiting') throw conflict(`This plan is ${row.state}.`);
      if (row.expires_at && row.expires_at < Date.now()) {
        await this.expire(row);
        throw conflict('This card expired before it was decided.');
      }
      return this.decidePlan(p, c, row, decision, steps);
    }
    if (row.user_id !== p.userId && !effectivePermissions(p).has('tools:manage')) throw forbidden('Only the conversation\'s owner or a tool admin decides this call.', { step: 'role' });
    if (row.state !== 'awaiting') throw conflict(`This call is ${row.state}.`);
    const t = Date.now();
    if (row.expires_at && row.expires_at < t) {
      await this.expire(row);
      throw conflict('This card expired before it was decided.');
    }
    const args = await this.open<Record<string, unknown>>(row.tenant_id, row.id, 'arguments', row.arguments, {});
    if (decision === 'deny') {
      await this.db('chat_invocations').where({ id: row.id }).update({ state: 'denied', decided_by: p.userId, decided_at: t, error: `Denied by ${p.displayName}.`, updated_at: t });
      await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.denied', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, tool: row.name }, label: c.label, detail: { by: 'owner' } });
      return this.recordDenied(p, c, row, `${p.displayName} denied this call.`);
    }
    const tool = await this.resolveTool(p, c, row.name);
    await this.db('chat_invocations').where({ id: row.id }).update({ decided_by: p.userId, decided_at: t, updated_at: t });
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.tool.approved', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, tool: row.name }, label: c.label, detail: { by: 'owner', alsoReviewer: row.approval === 'owner+reviewer' } });
    if (row.approval === 'owner+reviewer') {
      // The owner agreed; the rule's approver decides too, in the Flags queue, before it runs.
      await this.db('chat_invocations').where({ id: row.id }).update({ state: 'held', updated_at: t });
      const after = { ...row, state: 'held' as InvocationState };
      await this.fileHold(p, c, after, args, row.error);
      this.emit(c, 'chat.invocation', { invocationId: row.id, state: 'held', kind: 'tool', name: row.name });
      return this.view(after, p, args);
    }
    await this.db('chat_invocations').where({ id: row.id }).update({ state: 'running', updated_at: t });
    return this.attempt(p, c, { ...row, state: 'running' }, tool, args, true);
  }

  /** A denied or rejected call leaves a turn that says so, so the model does not try again blindly. */
  private async recordDenied(p: Principal, c: ConversationRow, row: InvocationRow, why: string) {
    const s = this.s();
    const args = await this.open<Record<string, unknown>>(row.tenant_id, row.id, 'arguments', row.arguments, {});
    const turn = await s.chat.appendTurn(c, { parentId: row.answer_id ?? c.head_id, turn: 'tool', name: row.name, invocationId: row.id, content: `${row.name} was not run: ${why}`, tools: [{ name: row.name, expression: JSON.stringify(args), error: why }], label: c.label, state: 'complete' });
    await this.db('chat_invocations').where({ id: row.id }).update({ message_id: turn.id, updated_at: Date.now() });
    this.emit(c, 'chat.invocation', { invocationId: row.id, state: 'denied', kind: 'tool', name: row.name, messageId: turn.id });
    return this.view({ ...row, state: 'denied', message_id: turn.id, error: why }, p, args);
  }

  private async expire(row: InvocationRow): Promise<void> {
    const t = Date.now();
    await this.db('chat_invocations').where({ id: row.id, state: 'awaiting' }).update({ state: 'expired', error: 'The card expired before it was decided.', updated_at: t });
    // 1.7.0 (B-11703): an answer waiting on its plan ends with the card.
    if (row.kind === 'plan' && row.answer_id) await this.s().chat.runPlan(row.tenant_id, row.answer_id, 'expired', null, 'The plan expired before it was decided.').catch(() => undefined);
    await this.s().audit.append({ tenantId: row.tenant_id, action: 'chat.tool.expired', kind: 'system', actor: { service: 'chat', user: row.user_id }, target: { conversation: row.conversation_id, invocation: row.id, tool: row.name }, label: row.label, detail: { proposedBy: row.proposed_by } });
  }

  /** Cards past their expiry (the chat sweep). */
  async expireCards(tenantId: string): Promise<number> {
    const rows = (await this.db('chat_invocations').where({ tenant_id: tenantId, state: 'awaiting' }).andWhere('expires_at', '<', Date.now())) as InvocationRow[];
    for (const r of rows) await this.expire(r);
    return rows.length;
  }

  // ---------- B-4004, B-4006: agent runs bound to a conversation ----------

  /** The recent turns the person allows an agent to see, within the agent's ceiling. */
  private async recentTurns(c: ConversationRow, headId: string | null, ceiling: Label, max: number): Promise<string> {
    if (!headId || max <= 0) return '';
    const rows = await this.s().chat.pathTexts(c, headId);
    const kept = rows.filter((m) => labelRank(m.label) <= labelRank(ceiling) && m.content.trim()).slice(-max);
    return kept.map((m) => `${m.role === 'user' ? 'Person' : m.name ? `Agent ${m.name}` : 'Assistant'}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 2000)}`).join('\n');
  }

  async startAgent(p: Principal, conversationId: string, input: { agent: string; input: string; includeTurns?: boolean }) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.kind !== 'chat') throw conflict('Agents are started from a chat, not a comparison.');
    if (c.user_id !== p.userId) throw forbidden('Only the conversation\'s owner starts agents in it.', { step: 'role' });
    const check = await s.agents.checkStart(p, { agent: input.agent, label: c.label });
    const e = await s.registry.resolve(p, check.agent, 'agent');
    if (!e) throw notFound('Agent');
    const task = input.input.trim();
    if (!task) throw conflict('Tell the agent what to do.');
    const context = input.includeTurns ? await this.recentTurns(c, c.head_id, e.label, s.cfg.CHAT_AGENT_CONTEXT_TURNS) : '';
    const runInput = context ? `${task}\n\nRecent turns of the conversation, for context:\n${context}` : task;
    const t = Date.now();
    const id = ulid();
    // The person's request and the agent's turn, so the thread shows who was asked and who answers.
    const user = await s.chat.appendTurn(c, { parentId: c.head_id, turn: null, role: 'user', name: null, invocationId: id, content: `@${e.name}: ${task}`, label: c.label, state: 'complete' });
    const placeholder = await s.chat.appendTurn(c, { parentId: user.id, turn: 'agent', name: e.name, invocationId: id, content: '', label: c.label, state: 'queued' });
    const root = s.chains ? await s.chains.begin(c.tenant_id, { kind: 'chat-turn', ref: placeholder.id, principal: p.userId, label: c.label }) : null;
    let run;
    try {
      run = await s.agents.start(p, { agent: e.id, input: runInput, label: c.label }, { chain: root ? { chain: root.chain, node: root.node } : null, caller: { kind: 'chat-turn', id: placeholder.id, node: root?.node ?? '' } });
    } catch (err) {
      await s.chat.completeTurn(c, placeholder.id, { content: '', state: 'failed', error: err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message });
      throw err;
    }
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: p.userId, kind: 'agent', name: e.name, entry_id: e.id, version: e.version, side_effect: null, proposed_by: 'user',
      arguments: await this.seal(c.tenant_id, id, 'arguments', { input: task, includeTurns: !!input.includeTurns }), state: 'running', approval: null, decided_by: null, decided_at: null, expires_at: null, run_kind: 'agent-run', run_id: run.id, chain_id: root?.chain ?? null, message_id: placeholder.id, answer_id: null, flag_id: null,
      result: null, error: null, label: run.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.agent.started', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: id, agent: e.name, version: e.version, run: run.id, message: placeholder.id }, label: run.label, detail: { includeTurns: !!input.includeTurns, chain: root?.chain ?? null } });
    this.emit(c, 'chat.invocation', { invocationId: id, state: 'running', kind: 'agent', name: e.name, runId: run.id, messageId: placeholder.id });
    return { ...(await this.view(row, p)), userMessageId: user.id, messageId: placeholder.id, runId: run.id };
  }

  /** B-4006: the model handed a turn to an agent and its run is still going when the answer ends: a turn of its own. */
  async adoptModelRun(c: ConversationRow, answerId: string, entry: EntryRow, runId: string, chainId: string | null): Promise<InvocationRow> {
    const s = this.s();
    const t = Date.now();
    const id = ulid();
    const placeholder = await s.chat.appendTurn(c, { parentId: answerId, turn: 'agent', name: entry.name, invocationId: id, content: '', label: c.label, state: 'queued' });
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: c.user_id, kind: 'agent', name: entry.name, entry_id: entry.id, version: entry.version, side_effect: null, proposed_by: 'model',
      arguments: null, state: 'running', approval: null, decided_by: null, decided_at: null, expires_at: null, run_kind: 'agent-run', run_id: runId, chain_id: chainId, message_id: placeholder.id, answer_id: answerId, flag_id: null,
      result: null, error: null, label: c.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    this.emit(c, 'chat.invocation', { invocationId: id, state: 'running', kind: 'agent', name: entry.name, runId, messageId: placeholder.id });
    // The run may have ended between the model's last poll and now.
    await this.runDone(c.tenant_id, 'agent-run', runId).catch(() => undefined);
    return row;
  }

  /** B-4004: cancelling the card stops the run; the turn records it. */
  async cancel(p: Principal, conversationId: string, id: string) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    const row = await this.row(c.tenant_id, id);
    if (row.conversation_id !== c.id) throw notFound('Invocation');
    if (!row.run_kind || !row.run_id) throw conflict('Only agent and workflow runs are cancelled; deny a tool card instead.');
    if (row.state !== 'running') throw conflict(`This run is ${row.state}.`);
    if (row.run_kind === 'agent-run') await s.agents.cancel(p, row.run_id);
    else await s.workflows.cancel(p, row.run_id);
    await s.audit.append({ tenantId: c.tenant_id, action: `chat.${row.kind}.cancelled`, kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: row.id, run: row.run_id }, label: row.label, detail: {} });
    await this.runDone(c.tenant_id, row.run_kind, row.run_id);
    return this.view(await this.row(c.tenant_id, id), p);
  }

  /**
   * A run started from a conversation ended (`onCallerDone`, or a cancel): the turn becomes the agent's answer (or
   * the workflow's outcome) and the card closes. `ref` is the run's id, or the chat turn the run names as caller.
   */
  async runDone(tenantId: string, kind: string, ref: string): Promise<void> {
    const s = this.s();
    const runKind = kind === 'workflow-run' ? 'workflow-run' : 'agent-run';
    const rows = (await this.db('chat_invocations').where({ tenant_id: tenantId, state: 'running' }).andWhere((q) => q.where({ run_kind: runKind, run_id: ref }).orWhere({ message_id: ref }).orWhere({ answer_id: ref }))) as InvocationRow[];
    for (const row of rows) {
      if (!row.run_id || !row.run_kind) continue;
      const c = await s.chat.conversationRow(row.tenant_id, row.conversation_id);
      if (!c) continue;
      let ended: { state: string; output: string | null; error: string | null; label: Label } | null;
      if (row.run_kind === 'agent-run') {
        const r = await s.agents.stateForStep(row.tenant_id, row.run_id);
        if (!r || !['succeeded', 'failed', 'cancelled', 'budget'].includes(r.state)) continue;
        ended = { state: r.state, output: r.output, error: r.error, label: r.label };
      } else {
        const r = await s.workflows.stateOfRun(row.tenant_id, row.run_id);
        if (!r || !['succeeded', 'failed', 'rejected', 'cancelled'].includes(r.state)) continue;
        ended = { state: r.state, output: r.output, error: r.error, label: r.label };
      }
      const ok = ended.state === 'succeeded';
      const state: InvocationState = ok ? 'done' : ended.state === 'cancelled' ? 'cancelled' : 'failed';
      const t = Date.now();
      await this.db('chat_invocations').where({ id: row.id, state: 'running' }).update({ state, result: ok ? await this.seal(row.tenant_id, row.id, 'result', ended.output) : null, error: ok ? null : (ended.error ?? `The run ${ended.state}.`), updated_at: t });
      if (row.message_id) {
        const content = ok ? (ended.output ?? '') : '';
        await s.chat.completeTurn({ ...c, label: highest(c.label, ended.label) }, row.message_id, { content, state: ok ? 'complete' : ended.state === 'cancelled' ? 'stopped' : 'failed', error: ok ? null : (ended.error ?? `The run ${ended.state}.`), label: ended.label });
      }
      await s.audit.append({ tenantId: row.tenant_id, action: `chat.${row.kind}.${ok ? 'finished' : ended.state === 'cancelled' ? 'cancelled' : 'failed'}`, kind: 'system', actor: { service: 'chat', user: row.user_id }, target: { conversation: row.conversation_id, invocation: row.id, run: row.run_id, message: row.message_id }, label: ended.label, detail: { state: ended.state, error: ended.error } });
      this.emit(c, 'chat.invocation', { invocationId: row.id, state, kind: row.kind, name: row.name, runId: row.run_id, messageId: row.message_id });
    }
  }

  // ---------- B-4009: workflows from a conversation ----------

  async startWorkflow(p: Principal, conversationId: string, input: { workflow: string; input: Record<string, unknown> }) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.kind !== 'chat') throw conflict('Workflows are started from a chat, not a comparison.');
    if (c.user_id !== p.userId) throw forbidden('Only the conversation\'s owner starts workflows in it.', { step: 'role' });
    const list = await s.workflows.list(p);
    const w = list.find((x) => x.id === input.workflow || x.name === input.workflow);
    if (!w) throw notFound('Workflow');
    if (!w.publishedVersion) throw conflict(`${w.name} has no published version.`);
    if (labelRank(c.label) > labelRank(w.label)) throw forbidden(`${w.name}'s ceiling is ${w.label}; this conversation is ${c.label}.`, { step: 'zone' });
    const t = Date.now();
    const id = ulid();
    const user = await s.chat.appendTurn(c, { parentId: c.head_id, turn: null, role: 'user', name: null, invocationId: id, content: `/workflow ${w.name} ${JSON.stringify(input.input)}`, label: c.label, state: 'complete' });
    const placeholder = await s.chat.appendTurn(c, { parentId: user.id, turn: 'workflow', name: w.name, invocationId: id, content: '', label: c.label, state: 'queued' });
    let run;
    try {
      run = await s.workflows.start(p, w.id, { input: input.input, dry: false, trigger: 'chat', chain: { via: { kind: 'chat-turn', ref: placeholder.id } }, caller: { kind: 'chat-turn', id: placeholder.id, node: '' } });
    } catch (err) {
      await s.chat.completeTurn(c, placeholder.id, { content: '', state: 'failed', error: err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message });
      throw err;
    }
    const chainId = s.chains ? ((await s.chains.find('workflow-run', run.id))?.chain ?? null) : null;
    const row: InvocationRow = {
      id, tenant_id: c.tenant_id, conversation_id: c.id, user_id: p.userId, kind: 'workflow', name: w.name, entry_id: w.id, version: String(w.publishedVersion), side_effect: null, proposed_by: 'user',
      arguments: await this.seal(c.tenant_id, id, 'arguments', input.input), state: 'running', approval: null, decided_by: null, decided_at: null, expires_at: null, run_kind: 'workflow-run', run_id: run.id, chain_id: chainId, message_id: placeholder.id, answer_id: null, flag_id: null,
      result: null, error: null, label: run.label, created_at: t, updated_at: t
    };
    await this.db('chat_invocations').insert(row);
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.workflow.started', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, invocation: id, workflow: w.id, run: run.id, message: placeholder.id }, label: run.label, detail: { name: w.name, version: w.publishedVersion } });
    this.emit(c, 'chat.invocation', { invocationId: id, state: 'running', kind: 'workflow', name: w.name, runId: run.id, messageId: placeholder.id });
    await this.runDone(c.tenant_id, 'workflow-run', run.id).catch(() => undefined);
    return { ...(await this.view(await this.row(c.tenant_id, id), p)), userMessageId: user.id, messageId: placeholder.id, runId: run.id };
  }

  // ---------- B-4005: skills on a conversation ----------

  skillsOf(c: ConversationRow): ConversationSkill[] {
    return json<ConversationSkill[]>(c.skills ?? null, []);
  }

  async addSkill(p: Principal, conversationId: string, input: { name: string; mode: 'sticky' | 'once' }) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.user_id !== p.userId) throw forbidden('Only the conversation\'s owner adds skills to it.', { step: 'role' });
    const e = await s.registry.resolve(p, input.name, 'skill');
    if (!e) throw notFound('Skill');
    if (labelRank(c.label) > labelRank(e.label)) throw forbidden(`${e.name}'s ceiling is ${e.label}; this conversation is ${c.label}.`, { step: 'zone' });
    if (c.profile_id) {
      const r = await this.profileOf(p, c);
      if (r.profile.skills && !r.profile.skills.includes(e.name)) throw forbidden(`Profile ${r.profile.name} allows only these skills: ${r.profile.skills.join(', ') || 'none'}.`, { step: 'role' });
    }
    const skills = this.skillsOf(c).filter((x) => x.name !== e.name);
    skills.push({ name: e.name, mode: input.mode });
    await this.db('conversations').where({ id: c.id }).update({ skills: JSON.stringify(skills), updated_at: Date.now() });
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.skill.added', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, skill: e.name, version: e.version }, label: c.label, detail: { mode: input.mode } });
    return { skills, skill: { name: e.name, version: e.version, mode: input.mode, description: e.description } };
  }

  async removeSkill(p: Principal, conversationId: string, name: string) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.user_id !== p.userId) throw forbidden('Only the conversation\'s owner removes skills from it.', { step: 'role' });
    const before = this.skillsOf(c);
    const skills = before.filter((x) => x.name !== name);
    if (skills.length === before.length) throw notFound('Skill');
    await this.db('conversations').where({ id: c.id }).update({ skills: JSON.stringify(skills), updated_at: Date.now() });
    await s.audit.append({ tenantId: c.tenant_id, action: 'chat.skill.removed', kind: 'decision', actor: actorFrom(p), target: { conversation: c.id, skill: name }, label: c.label, detail: {} });
    return { skills };
  }

  /** The instructions of the conversation's skills (their closure), for the system prompt, and whether any is one-turn. */
  async skillPrompt(p: Principal, c: ConversationRow): Promise<{ text: string; once: boolean; loaded: string[] }> {
    const skills = this.skillsOf(c);
    if (!skills.length) return { text: '', once: false, loaded: [] };
    const closure = await skillClosure(this.s().registry, p, skills.map((x) => x.name));
    const parts = closure.skills.filter((e) => labelRank(c.label) <= labelRank(e.label)).map((e) => `Skill ${e.name} ${e.version}:\n${String(e.definition.instructions ?? '')}`);
    return { text: parts.join('\n\n'), once: skills.some((x) => x.mode === 'once'), loaded: closure.skills.map((e) => e.name) };
  }

  /** After an answer: one-turn skills come off. */
  async dropOnceSkills(c: ConversationRow): Promise<void> {
    const skills = this.skillsOf(c);
    if (!skills.some((x) => x.mode === 'once')) return;
    await this.db('conversations').where({ id: c.id }).update({ skills: JSON.stringify(skills.filter((x) => x.mode !== 'once')), updated_at: Date.now() });
  }

  // ---------- views ----------

  async list(p: Principal, conversationId: string) {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    const rows = (await this.db('chat_invocations').where({ tenant_id: c.tenant_id, conversation_id: c.id }).orderBy('created_at')) as InvocationRow[];
    const out = [];
    for (const r of rows) out.push(await this.view(r, p));
    return out;
  }

  private async view(r: InvocationRow, p: Principal, args?: Record<string, unknown>) {
    const s = this.s();
    const a = args ?? (await this.open<Record<string, unknown> | null>(r.tenant_id, r.id, 'arguments', r.arguments, null));
    const base = {
      id: r.id,
      kind: r.kind,
      name: r.name,
      version: r.version,
      sideEffect: r.side_effect,
      proposedBy: r.proposed_by,
      arguments: clears(p.clearance, r.label) ? a : null,
      state: r.state,
      approval: r.approval,
      decidedBy: r.decided_by,
      decidedAt: r.decided_at,
      expiresAt: r.expires_at,
      run: r.run_kind && r.run_id ? { kind: r.run_kind, id: r.run_id } : null,
      chain: r.chain_id,
      messageId: r.message_id,
      answerId: r.answer_id,
      flag: r.flag_id,
      error: r.error,
      label: r.label,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // 1.7.0 (B-11703): a plan card's steps and the tools the turn may call under it.
      ...(r.kind === 'plan' && a ? { plan: { steps: (a as { steps?: unknown }).steps ?? [], tools: (a as { tools?: unknown }).tools ?? [], offered: (a as { offered?: unknown }).offered ?? [], edited: !!(a as { edited?: unknown }).edited } } : {})
    };
    if (!ACTIVE.includes(r.state) || !r.run_id) return base;
    // Live runs: what the card shows while it works, and what waits for a decision in the chain (B-4106, B-4009).
    let held: unknown[] = [];
    let approvals: unknown[] = [];
    let runState: string | null = null;
    try {
      if (r.run_kind === 'agent-run') runState = (await s.agents.stateForStep(r.tenant_id, r.run_id))?.state ?? null;
      else {
        const w = await s.workflows.stateOfRun(r.tenant_id, r.run_id);
        runState = w?.state ?? null;
        approvals = (await s.workflows.pendingApprovals(p)).filter((x) => (x as { runId: string }).runId === r.run_id);
      }
      if (r.chain_id && s.chains) {
        const { rootHeld } = await import('../chain/view.js');
        held = await rootHeld(s, p, { id: r.chain_id, node: null });
      }
    } catch {
      /* the card shows what it can */
    }
    return { ...base, runState, approvals, held };
  }
}
