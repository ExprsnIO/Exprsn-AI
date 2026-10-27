import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import type { ChatAllow, ProfileRow } from '../gateway/repo.js';
import type { ChatMessage } from '../gateway/ollama.js';
import { CHAT_CALLER } from '../agents/service.js';
import { decideHeld, rootHeld, type HeldCall } from '../chain/view.js';
import { flagRef } from '../guardrails/flags.js';
import type { UntrustedVerdict } from '../guardrails/injection.js';
import type { ToolOutcome } from '../registry/dispatch.js';
import { validateAgainst } from '../registry/schema.js';
import { MAX_BUDGETS, type AgentBudgets, type AgentDefinition, type EntryRow } from '../registry/service.js';
import { skillClosure, skillNames } from '../registry/skills.js';
import type { Services } from '../services.js';
import type { ConversationRow, InvocationKind } from './service.js';

/*
 * Agents, tools and skills in chat (B-40, 1.7.0).
 *
 * A person calls a published tool (`/tool`), agent (`@agent`), skill (`+skill`) or workflow (`/workflow`) from a
 * conversation. Nothing here decides on its own what may run: the registry's publish scope, the dispatcher with the
 * `tool-call` guardrail and its approval rule, agent runs with their budgets and approvals, workflow runs with theirs
 * and the chain's held calls decide, as they do everywhere else. This module is the conversation's side of them:
 *
 * - `capabilities` (B-4001): what the caller may call in a conversation. An entry is offered when it is published to
 *   the workspace, the caller holds the permission for its kind, the conversation's label is within the entry's
 *   ceiling (a registry entry's label is the highest data it may receive), the profile's allow-list names it (when the
 *   profile has one for that kind) and, for a workflow, whose label its run carries, that label is within the
 *   conversation's ceiling (the lower of the caller's clearance and the workspace's ceiling). Every call resolves its
 *   entry through the same list, so what is not listed is refused by name the same way: not found.
 * - an invocation (`chat_invocations`) is one call. It adds two messages to the conversation tree (the person's turn
 *   and the turn that carries the result), holds the exact arguments sealed, and for a tool the approval card: write,
 *   destructive and `confirm: always` tools wait for the caller's own approval (B-4003); a call the guardrail holds
 *   waits for a reviewer other than the caller in the flag queue (B-4002). A card that is denied, rejected or expires
 *   is recorded and runs nothing. The call itself is the job `chat.tool`, through the dispatcher.
 * - `@agent` and `/workflow` start a run whose caller is the invocation (`caller_kind: chat-invocation`); the run is
 *   the root of its own chain, so its budgets, approvals, cancel and chain tree are those of the Runs screen, and a
 *   call held anywhere below it is decided from the conversation's card (B-4004, B-4009).
 * - skills added to a conversation (`chat_conversation_skills`) are read at the start of every turn, so a removed
 *   skill is out of the very next one (B-4005).
 */

export type InvocationState = 'pending' | 'held' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'denied' | 'rejected' | 'expired' | 'cancelled' | 'budget' | 'blocked';

interface InvocationRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  conversation_id: string;
  user_id: string;
  kind: InvocationKind;
  entry_id: string;
  entry_name: string;
  entry_version: string;
  entry_hash: string | null;
  side_effect: string | null;
  profile: string | null;
  state: InvocationState;
  label: Label;
  args: string | null;
  result: string | null;
  error: string | null;
  from_text: boolean;
  needs: string | null;
  caller_decision: string | null;
  caller_decided_at: number | null;
  reviewer_decision: string | null;
  reviewer_id: string | null;
  reviewer_decided_at: number | null;
  flag_id: string | null;
  hold_reason: string | null;
  expires_at: number | null;
  run_kind: 'agent-run' | 'workflow-run' | null;
  run_id: string | null;
  job_id: string | null;
  user_message_id: string;
  message_id: string;
  created_at: number;
  updated_at: number;
}

const ENDED: InvocationState[] = ['succeeded', 'failed', 'denied', 'rejected', 'expired', 'cancelled', 'blocked'];
const JOB = 'chat.tool';
const lower = (a: Label, b: Label): Label => (labelRank(a) <= labelRank(b) ? a : b);
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** What applies to a conversation: its label, its ceiling and the profile whose allow-list restricts it. */
interface Scope {
  c: ConversationRow | null;
  label: Label;
  ceiling: Label;
  profile: ProfileRow | null;
  allow: ChatAllow;
}

interface Offered {
  tools: EntryRow[];
  agents: EntryRow[];
  skills: EntryRow[];
  workflows: { id: string; name: string; version: number | null; description: string | null; label: Label; input: unknown }[];
  may: { tools: boolean; agents: boolean; skills: boolean; workflows: boolean };
}

export class ChatCapabilities {
  constructor(private readonly svc: () => Services) {}

  private get s(): Services {
    return this.svc();
  }

  private get db() {
    return this.s.db;
  }

  registerJobs(): void {
    // One attempt: a call that may have changed something is never made twice by a retry.
    this.s.jobs.register(JOB, async (p, ctx) => this.runTool(String(p.invocationId), p.approved === true, ctx.signal), { timeoutMs: 15 * 60_000 });
  }

  // ---------- B-4001: what a conversation may call ----------

  private async scope(p: Principal, conversationId: string | null, profileName?: string | null): Promise<Scope> {
    const c = conversationId ? await this.s.chat.conversation(p, conversationId) : null;
    if (c && c.kind !== 'chat') throw conflict('This is a comparison; start a chat from one of its answers instead.');
    // What is published is published to a workspace: a conversation is acted in from the workspace it belongs to.
    if (c && c.workspace_id !== (p.workspaceId ?? null)) throw notFound('Conversation');
    const label = c?.label ?? (await this.s.chat.defaultLabel(p));
    // A conversation above its owner's clearance (lowered since) is not theirs to act in.
    if (!clears(p.clearance, label)) throw notFound('Conversation');
    const wsId = c ? c.workspace_id : (p.workspaceId ?? null);
    const ws = wsId ? await this.s.tenants.workspace(p.tenantId, wsId) : undefined;
    const ceiling = ws ? lower(p.clearance, ws.label_ceiling) : p.clearance;
    const profile = await this.profile(p, profileName ?? c?.profile_id ?? null, !!profileName);
    return { c, label, ceiling, profile, allow: profile?.chat_capabilities ?? {} };
  }

  /** The profile whose allow-list applies: one the caller may use (an alias counts as its target), or none yet. */
  private async profile(p: Principal, nameOrId: string | null, asked: boolean): Promise<ProfileRow | null> {
    if (!nameOrId) return null;
    const rows = await this.s.gateway.repo.profiles(p.tenantId);
    const row = rows.find((x) => x.name === nameOrId || x.id === nameOrId);
    let target = row;
    for (let i = 0; target?.alias_of && i < 5; i++) target = rows.find((x) => x.id === target!.alias_of);
    const usable = !!row && !!target && !target.alias_of && row.status === 'published' && target.status === 'published' && clears(p.clearance, target.label) && (!p.profiles || p.profiles.includes(row.name) || p.profiles.includes(target.name));
    if (!usable) {
      // A profile named in the request must be one the caller may use; the conversation's last one may have gone.
      if (asked) throw notFound('Profile');
      return null;
    }
    return target!;
  }

  private allowed(list: string[] | undefined, name: string): boolean {
    return !list || list.includes(name);
  }

  /** The newest callable version per name of a kind, published to the caller's workspace. */
  private async published(p: Principal, kind: 'tool' | 'skill' | 'agent'): Promise<EntryRow[]> {
    const rows = (await this.s.registry.list(p.tenantId, { kind })).filter((e) => (e.status === 'published' || e.status === 'deprecated') && e.approved_hash === e.schema_hash && this.s.registry.visibleTo(e, p));
    const byName = new Map<string, EntryRow>();
    for (const e of rows.sort((a, b) => b.created_at - a.created_at)) if (!byName.has(e.name) || (byName.get(e.name)!.status !== 'published' && e.status === 'published')) byName.set(e.name, e);
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private async offered(p: Principal, sc: Scope): Promise<Offered> {
    const perms = effectivePermissions(p);
    const may = { tools: perms.has('tools:invoke'), agents: perms.has('agents:run'), skills: perms.has('chat:write'), workflows: perms.has('agents:run') };
    const within = (e: EntryRow) => labelRank(sc.label) <= labelRank(e.label);
    const out: Offered = { tools: [], agents: [], skills: [], workflows: [], may };
    if (may.tools) {
      // Workflows published as tools are started with /workflow, where their approvals have a card.
      const candidates = (await this.published(p, 'tool')).filter((e) => e.impl !== 'workflow' && e.impl !== 'agent' && this.allowed(sc.allow.tools, e.name));
      // The dispatcher decides availability (the ceiling, an MCP server that is down or not authorised for the user).
      const ok = new Set((await this.s.tools.resolve(p, candidates.map((e) => e.name), sc.label)).tools.map((t) => t.entry.id));
      out.tools = candidates.filter((e) => ok.has(e.id));
    }
    if (may.agents) out.agents = (await this.published(p, 'agent')).filter((e) => within(e) && this.allowed(sc.allow.agents, e.name));
    if (may.skills) out.skills = (await this.published(p, 'skill')).filter((e) => within(e) && this.allowed(sc.allow.skills, e.name));
    if (may.workflows) {
      const callees = (await this.s.workflows.callees(p)).workflows.filter((w) => labelRank(w.label) <= labelRank(sc.ceiling) && this.allowed(sc.allow.workflows, w.name));
      const described = callees.length ? new Map(((await this.db('workflows').where({ tenant_id: p.tenantId }).whereIn('id', callees.map((w) => w.id)).select('id', 'description')) as { id: string; description: string | null }[]).map((w) => [w.id, w.description])) : new Map<string, string | null>();
      out.workflows = callees.map((w) => ({ id: w.id, name: w.name, version: w.version, description: described.get(w.id) ?? null, label: w.label, input: w.input }));
    }
    return out;
  }

  async capabilities(p: Principal, conversationId: string | null, profileName?: string | null) {
    const sc = await this.scope(p, conversationId, profileName);
    const o = await this.offered(p, sc);
    const active = sc.c ? new Map(((await this.db('chat_conversation_skills').where({ conversation_id: sc.c.id }).select('skill', 'mode')) as { skill: string; mode: string }[]).map((r) => [r.skill, r.mode])) : new Map<string, string>();
    return {
      conversation: { id: sc.c?.id ?? null, label: sc.label, ceiling: sc.ceiling, profile: sc.profile?.name ?? null },
      may: o.may,
      restricted: { tools: !!sc.allow.tools, agents: !!sc.allow.agents, skills: !!sc.allow.skills, workflows: !!sc.allow.workflows },
      tools: o.tools.map((e) => ({ id: e.id, name: e.name, version: e.version, description: e.description, impl: e.impl, sideEffect: e.side_effect ?? 'read', confirm: e.confirm, ceiling: e.label, inputSchema: e.input_schema ?? { type: 'object', properties: {} }, approval: needsCaller(e) ? 'caller' : 'none', deprecated: e.status === 'deprecated' })),
      agents: o.agents.map((e) => {
        const def = e.definition as unknown as AgentDefinition;
        return { id: e.id, name: e.name, version: e.version, description: e.description, ceiling: e.label, profile: def.profile, budgets: def.budgets ?? null, inputSchema: e.input_schema, deprecated: e.status === 'deprecated' };
      }),
      skills: o.skills.map((e) => ({ id: e.id, name: e.name, version: e.version, description: e.description, ceiling: e.label, tools: skillNames(e, 'tools'), active: active.get(e.name) ?? null })),
      workflows: o.workflows.map((w) => ({ id: w.id, name: w.name, version: w.version, description: w.description, label: w.label, inputSchema: w.input }))
    };
  }

  // ---------- rows ----------

  private async row(c: Pick<ConversationRow, 'id' | 'tenant_id'>, id: string): Promise<InvocationRow> {
    const r = (await this.db('chat_invocations').where({ tenant_id: c.tenant_id, conversation_id: c.id, id }).first()) as InvocationRow | undefined;
    if (!r) throw notFound('Invocation');
    return rowFrom(r);
  }

  private async byId(tenantId: string, id: string): Promise<InvocationRow | undefined> {
    const r = (await this.db('chat_invocations').where({ tenant_id: tenantId, id }).first()) as InvocationRow | undefined;
    return r ? rowFrom(r) : undefined;
  }

  private seal(inv: Pick<InvocationRow, 'tenant_id' | 'id'>, field: 'args' | 'result', value: unknown): Promise<string> {
    return this.s.keys.seal(inv.tenant_id, JSON.stringify(value ?? null), `chat-invocation-${field}:${inv.id}`);
  }

  private async open<T>(inv: InvocationRow, field: 'args' | 'result', fallback: T): Promise<T> {
    const v = inv[field];
    return v ? json<T>(await this.s.keys.open(inv.tenant_id, v, `chat-invocation-${field}:${inv.id}`), fallback) : fallback;
  }

  /** Moves an invocation on from one of `from` (one conditional update, so two decisions never both apply). */
  private async move(inv: InvocationRow, from: InvocationState[], patch: Partial<InvocationRow>): Promise<InvocationRow | null> {
    const upd = { ...patch, updated_at: Date.now() };
    const n = await this.db('chat_invocations').where({ id: inv.id }).whereIn('state', from).update(upd);
    if (!n) return null;
    const after = { ...inv, ...upd } as InvocationRow;
    this.s.chat.notify({ user_id: inv.user_id, tenant_id: inv.tenant_id }, 'chat.invocation', { conversationId: inv.conversation_id, invocationId: inv.id, kind: inv.kind, state: after.state, messageId: inv.message_id });
    return after;
  }

  private audit(p: Principal | null, inv: Pick<InvocationRow, 'tenant_id' | 'conversation_id' | 'id' | 'kind' | 'entry_name' | 'entry_version' | 'label' | 'user_id'>, action: string, detail: Record<string, unknown> = {}, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    return this.s.audit.append({ tenantId: inv.tenant_id, action, kind: p ? 'admin' : 'system', actor: p ? actorFrom(p, o.ip ?? null) : { service: 'chat', user: inv.user_id }, target: { conversation: inv.conversation_id, invocation: inv.id, [inv.kind]: inv.entry_name, version: inv.entry_version }, label: inv.label, detail, ...(o.traceId ? { traceId: o.traceId } : {}) });
  }

  private conv(inv: InvocationRow): Pick<ConversationRow, 'id' | 'tenant_id' | 'user_id'> {
    return { id: inv.conversation_id, tenant_id: inv.tenant_id, user_id: inv.user_id };
  }

  /** The call ended without a result the model should read: its two turns are withdrawn (or failed). */
  private async withdraw(inv: InvocationRow, state: 'failed' | 'withdrawn', error: string | null): Promise<void> {
    await this.s.chat.settleInvocationTurn(this.conv(inv), { userMessageId: inv.user_message_id, messageId: inv.message_id, state, error });
  }

  private async insert(p: Principal, c: ConversationRow, id: string, o: { kind: InvocationKind; entry: Pick<EntryRow, 'id' | 'name' | 'version'> & { schema_hash?: string | null; side_effect?: string | null }; profile: string | null; label: Label; args: unknown; fromText?: boolean; turn: { userMessageId: string; messageId: string } }): Promise<InvocationRow> {
    const t = Date.now();
    const row: InvocationRow = { id, tenant_id: c.tenant_id, workspace_id: c.workspace_id, conversation_id: c.id, user_id: p.userId, kind: o.kind, entry_id: o.entry.id, entry_name: o.entry.name, entry_version: String(o.entry.version), entry_hash: o.entry.schema_hash ?? null, side_effect: o.entry.side_effect ?? null, profile: o.profile, state: 'running', label: o.label, args: null, result: null, error: null, from_text: !!o.fromText, needs: null, caller_decision: null, caller_decided_at: null, reviewer_decision: null, reviewer_id: null, reviewer_decided_at: null, flag_id: null, hold_reason: null, expires_at: null, run_kind: null, run_id: null, job_id: null, user_message_id: o.turn.userMessageId, message_id: o.turn.messageId, created_at: t, updated_at: t };
    row.args = await this.seal(row, 'args', o.args);
    await this.db('chat_invocations').insert(row);
    return row;
  }

  // ---------- B-4002, B-4003: /tool ----------

  /** The user-input checkpoint for text a person hands to a model or an agent from the composer. */
  private async guardText(p: Principal, c: ConversationRow, text: string): Promise<string> {
    const d = await this.s.guardrails.check({ tenantId: p.tenantId, workspaceId: c.workspace_id, checkpoint: 'user-input', text, label: c.label, principal: p, source: { kind: 'conversation', id: c.id }, meta: { tokens: Math.ceil(text.length / 4), via: 'chat', conversationId: c.id } });
    if (d.action === 'block' || d.action === 'require-approval') {
      const rules = [...new Set(d.findings.filter((f) => f.stage === 'enforce' && f.action === d.action).map((f) => f.ruleName))];
      throw new HttpProblem(422, d.action === 'block' ? 'Blocked by guardrail' : 'Held by guardrail', d.reason ?? 'A guardrail refused this message.', { extensions: { step: 'guardrail', action: d.action, rules } });
    }
    return d.text;
  }

  /**
   * "Text the profile turns into arguments": one call of the profile's model, offered only this tool, metered to the
   * conversation. What it proposes is shown on a card before anything runs.
   */
  private async argumentsFromText(p: Principal, c: ConversationRow, sc: Scope, entry: EntryRow, text: string): Promise<Record<string, unknown>> {
    if (!effectivePermissions(p).has('inference:invoke')) throw forbidden('Turning text into arguments calls the model, which your roles do not allow; fill in the form instead.', { step: 'role', action: 'inference:invoke' });
    if (!sc.profile) throw badRequest('Name the profile whose model turns the text into arguments.');
    const said = await this.guardText(p, c, text);
    const r = await this.s.chat.profileFor(p, sc.profile.name, c.label);
    await this.s.quotas.admit(p.tenantId, c.workspace_id);
    const tool = this.s.tools.toResolved(entry);
    const canCall = r.model.capabilities.includes('tools') && !r.model.evaluation?.toolsWithheld;
    const messages: ChatMessage[] = [
      { role: 'system', content: `Turn the request into the arguments of the tool ${tool.fn}. ${canCall ? `Call ${tool.fn} once with them` : 'Answer with one JSON object holding them'} and nothing else. Use only what the request says; leave out optional arguments it does not mention.${canCall ? '' : `\n\nThe tool: ${entry.description ?? entry.name}\nIts input schema: ${JSON.stringify(tool.def.function.parameters)}`}` },
      { role: 'user', content: said }
    ];
    let proposed: Record<string, unknown> | null = null;
    let content = '';
    let prompt = 0;
    let output = 0;
    let gpuNs = 0;
    const signal = AbortSignal.timeout(120_000);
    const got = await this.s.gateway.runFollowing(r, c.label, { signal }, async (id) => this.s.chat.profileFor(p, id, c.label).catch(() => null), async (use, lease) => {
      try {
        proposed = null;
        content = '';
        for await (const chunk of lease.client.chat({ model: use.model.name, messages, ...(use.model.capabilities.includes('thinking') ? { think: false } : {}), ...(canCall && use.model.capabilities.includes('tools') ? { tools: [tool.def] } : {}), options: { temperature: 0 } }, signal)) {
          if (chunk.message?.content) content += chunk.message.content;
          const call = chunk.message?.tool_calls?.find((x) => x.function?.name === tool.fn);
          if (call && !proposed) proposed = (call.function.arguments ?? {}) as Record<string, unknown>;
          if (chunk.done) {
            prompt = chunk.prompt_eval_count ?? 0;
            output = chunk.eval_count ?? 0;
            gpuNs = (chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0);
          }
        }
      } finally {
        lease.release(null);
      }
    });
    if (!prompt && !output) prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
    await this.s.quotas.record({ tenantId: c.tenant_id, workspaceId: c.workspace_id, userId: p.userId, apiKeyId: p.apiKeyId, kind: 'chat', profileId: got.resolved.profile.id, model: got.resolved.model.name, poolId: got.lease.pool.id, conversationId: c.id, promptTokens: prompt, outputTokens: output, gpuMs: gpuNs / 1e6 });
    let args = proposed as Record<string, unknown> | null;
    if (!args) {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
      try {
        const v = JSON.parse((fenced ? fenced[1]! : content).trim()) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown>;
      } catch {
        args = null;
      }
    }
    if (!args) throw new HttpProblem(422, 'No arguments', `${got.resolved.profile.name} did not turn that into arguments for ${entry.name}. Fill in the form instead.`);
    return args;
  }

  async callTool(p: Principal, conversationId: string, input: { tool: string; arguments?: Record<string, unknown> | undefined; text?: string | undefined; profile?: string | undefined; parentId?: string | null | undefined }, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const sc = await this.scope(p, conversationId, input.profile ?? null);
    const c = sc.c!;
    const entry = (await this.offered(p, sc)).tools.find((e) => e.name === input.tool);
    // Not published here, above the ceiling, not on the profile's list: one answer, which says nothing about which.
    if (!entry) throw notFound('Tool');
    const fromText = input.arguments === undefined && input.text !== undefined;
    const args = fromText ? await this.argumentsFromText(p, c, sc, entry, input.text!) : (input.arguments ?? {});
    const invalid = validateAgainst(entry.input_schema, args);
    if (invalid.length) throw badRequest(`The arguments do not match the input schema of ${entry.name}${fromText ? ' (as the model wrote them); fill in the form instead' : ''}.`, { errors: invalid.slice(0, 10).map((message) => ({ path: 'arguments', message })) });
    const id = ulid();
    const turn = await this.s.chat.addInvocationTurn(p, c, { kind: 'tool', invocationId: id, text: `Called the tool ${entry.name} with ${JSON.stringify(args)}`, label: c.label, parentId: input.parentId });
    let inv = await this.insert(p, c, id, { kind: 'tool', entry, profile: sc.profile?.name ?? null, label: c.label, args, fromText, turn });
    await this.audit(p, inv, 'chat.tool.called', { sideEffect: entry.side_effect ?? 'read', confirm: entry.confirm, fromText, profile: inv.profile }, o);

    const card = needsCaller(entry) || fromText;
    if (!card) {
      // A read tool: the job makes the call; the guardrail may still hold or block it there.
      inv = await this.enqueue(inv, false);
      return this.view(p, inv);
    }
    // A write, destructive or always-confirm call cannot run unapproved, so asking the dispatcher now only tells what
    // the guardrail says: blocked, or held for a reviewer as well as the caller.
    let needs = 'caller';
    let reason: string | null = null;
    if (needsCaller(entry)) {
      const probe = await this.s.tools.call({ principal: p, label: c.label, source: { kind: CHAT_CALLER, id } }, this.s.tools.toResolved(entry), args);
      if (!probe.needsApproval) {
        const state: InvocationState = probe.decision === 'block' ? 'blocked' : 'failed';
        inv = (await this.move(inv, ['running'], { state, error: (probe.error ?? 'The call was refused.').slice(0, 1000) })) ?? inv;
        await this.withdraw(inv, state === 'blocked' ? 'withdrawn' : 'failed', inv.error);
        await this.audit(p, inv, `chat.tool.${state}`, { reason: inv.error }, o);
        return this.view(p, inv);
      }
      if (probe.decision === 'require-approval') {
        needs = 'caller,reviewer';
        reason = probe.error ?? null;
      }
    }
    inv = (await this.move(inv, ['running'], { state: 'pending', needs, hold_reason: reason?.slice(0, 500) ?? null, expires_at: Date.now() + this.s.cfg.CHAT_CARD_EXPIRY_MINUTES * 60_000 })) ?? inv;
    return this.view(p, inv);
  }

  private async enqueue(inv: InvocationRow, approved: boolean): Promise<InvocationRow> {
    const job = await this.s.jobs.enqueue({ tenantId: inv.tenant_id, type: JOB, payload: { invocationId: inv.id, approved }, createdBy: inv.user_id, maxAttempts: 1 });
    await this.db('chat_invocations').where({ id: inv.id }).update({ job_id: job.id });
    return { ...inv, job_id: job.id };
  }

  /** The caller's own decision on a pending card (B-4003). */
  async decide(p: Principal, conversationId: string, id: string, decision: 'approve' | 'deny', note: string | null, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const c = await this.s.chat.conversation(p, conversationId);
    let inv = await this.row(c, id);
    if (inv.kind !== 'tool') throw conflict('Only a tool call has an approval card of its own; a run is decided where it waits.');
    if (await this.expireOne(inv)) throw conflict('This card expired; nothing ran. Make the call again.');
    if (inv.state !== 'pending') throw conflict(`This call is ${inv.state}, not waiting for your approval.`);
    if (decision === 'deny') {
      const after = await this.move(inv, ['pending'], { state: 'denied', caller_decision: 'denied', caller_decided_at: Date.now(), error: note ? `Denied: ${note}`.slice(0, 1000) : null });
      if (!after) throw conflict('This card was decided a moment ago.');
      await this.withdraw(after, 'withdrawn', 'Denied. Nothing ran.');
      await this.audit(p, after, 'chat.tool.denied', { sideEffect: after.side_effect, note }, o);
      return this.view(p, after);
    }
    // What is approved is what the card showed: the same entry, unchanged since.
    const entry = await this.sameEntry(p, inv);
    let needs = inv.needs ?? 'caller';
    let reason = inv.hold_reason;
    if (inv.from_text && needsCaller(entry)) {
      // A card that came from text was not asked of the guardrail yet.
      const probe = await this.s.tools.call({ principal: p, label: c.label, source: { kind: CHAT_CALLER, id: inv.id } }, this.s.tools.toResolved(entry), await this.open<Record<string, unknown>>(inv, 'args', {}));
      if (!probe.needsApproval) {
        const state: InvocationState = probe.decision === 'block' ? 'blocked' : 'failed';
        const after = await this.move(inv, ['pending'], { state, caller_decision: 'approved', caller_decided_at: Date.now(), error: (probe.error ?? 'The call was refused.').slice(0, 1000) });
        if (!after) throw conflict('This card was decided a moment ago.');
        await this.withdraw(after, state === 'blocked' ? 'withdrawn' : 'failed', after.error);
        await this.audit(p, after, `chat.tool.${state}`, { reason: after.error }, o);
        return this.view(p, after);
      }
      if (probe.decision === 'require-approval') {
        needs = 'caller,reviewer';
        reason = probe.error ?? null;
      }
    }
    const held = needs.includes('reviewer');
    const after = await this.move(inv, ['pending'], { state: held ? 'held' : 'running', needs, hold_reason: reason?.slice(0, 500) ?? null, caller_decision: 'approved', caller_decided_at: Date.now(), expires_at: held ? Date.now() + this.s.cfg.CHAT_HELD_CALL_EXPIRY_HOURS * 3_600_000 : null });
    if (!after) throw conflict('This card was decided a moment ago.');
    inv = after;
    await this.audit(p, inv, 'chat.tool.approved', { sideEffect: inv.side_effect, by: 'caller', note, reviewer: held }, o);
    if (held) inv = await this.fileHold(inv, reason);
    // A read tool approved from a text card is still asked of the guardrail by the job, which may hold it.
    else inv = await this.enqueue(inv, needsCaller(entry));
    return this.view(p, inv);
  }

  /** The entry a card was shown for, still offered and unchanged; otherwise the call fails and says so. */
  private async sameEntry(p: Principal, inv: InvocationRow): Promise<EntryRow> {
    const sc = await this.scope(p, inv.conversation_id, null);
    const allow = (inv.profile ? (await this.profile(p, inv.profile, false))?.chat_capabilities : null) ?? sc.allow;
    const entry = (await this.offered(p, { ...sc, allow })).tools.find((e) => e.name === inv.entry_name);
    if (!entry || entry.id !== inv.entry_id || entry.schema_hash !== inv.entry_hash) {
      const error = entry ? `${inv.entry_name} changed after the card was shown; nothing ran. Make the call again.` : `${inv.entry_name} is no longer offered in this conversation; nothing ran.`;
      const after = await this.move(inv, ['pending', 'held', 'running'], { state: 'failed', error });
      if (after) {
        await this.withdraw(after, 'failed', error);
        await this.audit(null, after, 'chat.tool.failed', { reason: error });
      }
      throw conflict(error);
    }
    return entry;
  }

  /** Files a held call in the flag queue, where a reviewer other than the caller decides (B-4002). */
  private async fileHold(inv: InvocationRow, reason: string | null): Promise<InvocationRow> {
    const args = await this.open<Record<string, unknown>>(inv, 'args', {});
    const who = (await this.db('users').where({ id: inv.user_id }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined;
    const flag = await this.s.guard.flags.create({
      tenantId: inv.tenant_id,
      workspaceId: inv.workspace_id,
      kind: 'hold',
      checkpoint: 'tool-call',
      ruleId: null,
      ruleName: 'Tool call held for review',
      setId: null,
      stage: 'enforce',
      action: 'require-approval',
      severity: inv.side_effect === 'destructive' ? 'high' : 'medium',
      label: inv.label,
      text: JSON.stringify({ tool: inv.entry_name, version: inv.entry_version, sideEffect: inv.side_effect ?? 'read', arguments: args }),
      span: null,
      note: reason ?? 'The tool-call guardrail held this call for review before it runs.',
      actor: { user: inv.user_id, name: who ? who.display_name || who.username : 'A person', via: 'chat' },
      source: { kind: CHAT_CALLER, id: inv.id },
      conversationId: inv.conversation_id
    });
    await this.db('chat_invocations').where({ id: inv.id }).update({ flag_id: flag.id });
    await this.audit(null, inv, 'chat.tool.held', { flag: flagRef(flag), reason });
    this.s.chat.notify({ user_id: inv.user_id, tenant_id: inv.tenant_id }, 'chat.invocation', { conversationId: inv.conversation_id, invocationId: inv.id, kind: inv.kind, state: 'held', messageId: inv.message_id });
    return { ...inv, flag_id: flag.id };
  }

  /** What a reviewer reads in the flag's detail: the tool and the exact arguments. */
  async heldText(tenantId: string, id: string): Promise<{ conversationId: string; state: string; content: string; label: Label } | null> {
    const inv = await this.byId(tenantId, id);
    if (!inv) return null;
    return { conversationId: inv.conversation_id, state: inv.state, content: JSON.stringify({ tool: inv.entry_name, version: inv.entry_version, sideEffect: inv.side_effect ?? 'read', arguments: await this.open<unknown>(inv, 'args', {}) }, null, 2), label: inv.label };
  }

  /** A reviewer's decision on a held call, from the flag queue: approved, it runs as its caller; rejected, nothing runs. */
  async resolveHold(reviewer: Principal, id: string, decision: 'approved' | 'rejected'): Promise<{ conversationId: string; state: InvocationState; label: Label }> {
    const inv = await this.byId(reviewer.tenantId, id);
    if (!inv) throw notFound('Invocation');
    if (inv.user_id === reviewer.userId) throw forbidden('This call was held in your own conversation; another reviewer decides on it.', { step: 'dual-control' });
    if (!clears(reviewer.clearance, inv.label)) throw forbidden(`The call is ${inv.label}; your clearance is ${reviewer.clearance}.`, { step: 'clearance' });
    if (await this.expireOne(inv)) throw conflict('This held call expired; nothing ran.');
    if (inv.state !== 'held') throw conflict(`This call is ${inv.state}, not held for review.`);
    const stamp = { reviewer_decision: decision, reviewer_id: reviewer.userId, reviewer_decided_at: Date.now() };
    const after = await this.move(inv, ['held'], decision === 'approved' ? { state: 'running', expires_at: null, ...stamp } : { state: 'rejected', error: `Rejected by ${reviewer.displayName}. Nothing ran.`, ...stamp });
    if (!after) throw conflict('Another reviewer decided on this call first.');
    await this.audit(reviewer, after, decision === 'approved' ? 'chat.tool.approved' : 'chat.tool.rejected', { sideEffect: after.side_effect, by: 'reviewer' });
    if (decision === 'approved') await this.enqueue(after, true);
    else await this.withdraw(after, 'withdrawn', after.error);
    await this.s.notifications.notify({ tenantId: inv.tenant_id, userIds: [inv.user_id], kind: 'chat', title: decision === 'approved' ? `${inv.entry_name}: a reviewer approved the held call` : `${inv.entry_name}: a reviewer rejected the held call`, body: decision === 'approved' ? 'It is running now.' : 'Nothing ran.', route: `chat?id=${inv.conversation_id}`, label: inv.label }).catch(() => undefined);
    return { conversationId: inv.conversation_id, state: after.state, label: inv.label };
  }

  /** The job: makes the call through the dispatcher as the conversation's owner and records how it ended. */
  private async runTool(id: string, approved: boolean, signal: AbortSignal): Promise<unknown> {
    const found = (await this.db('chat_invocations').where({ id }).first()) as InvocationRow | undefined;
    if (!found) return { skipped: 'missing' };
    const inv = rowFrom(found);
    if (inv.state !== 'running' || inv.kind !== 'tool') return { skipped: inv.state };
    const fail = async (error: string, state: InvocationState = 'failed') => {
      const after = await this.move(inv, ['running'], { state, error: error.slice(0, 1000) });
      if (after) {
        await this.withdraw(after, state === 'failed' ? 'failed' : 'withdrawn', after.error);
        await this.audit(null, after, `chat.tool.${state}`, { reason: after.error });
      }
      return { state };
    };
    const p = await loadPrincipal(this.s, inv.tenant_id, inv.user_id, {});
    if (!p) return fail('The person who made the call can no longer sign in.');
    p.workspaceId = inv.workspace_id;
    let c: ConversationRow;
    let entry: EntryRow;
    try {
      c = await this.s.chat.conversation(p, inv.conversation_id);
      entry = await this.sameEntry(p, inv);
    } catch (err) {
      return fail(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
    }
    // Only a call both approvals cover runs approved; a read call is asked of the guardrail here.
    const covered = approved && (!needsCaller(entry) || inv.caller_decision === 'approved') && (!(inv.needs ?? '').includes('reviewer') || inv.reviewer_decision === 'approved');
    if (approved && !covered) return fail('The call was not approved by everyone it needs; nothing ran.');
    const args = await this.open<Record<string, unknown>>(inv, 'args', {});
    let o: ToolOutcome;
    try {
      o = await this.s.tools.call({ principal: p, label: c.label, source: { kind: CHAT_CALLER, id: inv.id }, signal, approved: covered, chainRoot: { kind: 'chat-turn', ref: inv.message_id } }, this.s.tools.toResolved(entry), args);
    } catch (err) {
      return fail((err as Error).message);
    }
    if (o.needsApproval) {
      // The guardrail holds a call nobody had to approve: it waits for a reviewer.
      const held = await this.move(inv, ['running'], { state: 'held', needs: needsCaller(entry) ? 'caller,reviewer' : 'reviewer', hold_reason: o.error?.slice(0, 500) ?? null, expires_at: Date.now() + this.s.cfg.CHAT_HELD_CALL_EXPIRY_HOURS * 3_600_000 });
      if (held) await this.fileHold(held, o.error ?? null);
      return { state: 'held' };
    }
    if (o.pending) return fail(`${entry.name} started work that finishes later; start it with /workflow or @agent instead.`);
    if (!o.ok) return fail(o.error ?? 'The tool failed.', o.decision === 'block' && o.denied ? 'blocked' : 'failed');
    const after = await this.move(inv, ['running'], { state: 'succeeded', result: await this.seal(inv, 'result', o.result), error: null });
    if (!after) return { skipped: 'changed' };
    await this.s.chat.settleInvocationTurn(c, { userMessageId: inv.user_message_id, messageId: inv.message_id, state: 'complete', tool: { name: entry.name, expression: JSON.stringify(o.arguments), output: o.result, untrusted: (o.untrusted ?? null) as UntrustedVerdict | null }, label: c.label });
    await this.audit(null, after, 'chat.tool.succeeded', { sideEffect: entry.side_effect ?? 'read', durationMs: o.durationMs, decision: o.decision, approvedBy: covered ? (inv.needs ?? 'caller') : null });
    this.s.chat.notify(c, 'chat.invocation', { conversationId: c.id, invocationId: inv.id, kind: inv.kind, state: 'succeeded', messageId: inv.message_id });
    return { state: 'succeeded' };
  }

  // ---------- expiry ----------

  private async expireOne(inv: InvocationRow): Promise<boolean> {
    if ((inv.state !== 'pending' && inv.state !== 'held') || inv.expires_at == null || inv.expires_at > Date.now()) return false;
    const after = await this.move(inv, [inv.state], { state: 'expired', error: inv.state === 'pending' ? 'Nobody approved the card in time. Nothing ran.' : 'No reviewer decided in time. Nothing ran.' });
    if (!after) return false;
    await this.withdraw(after, 'withdrawn', after.error);
    await this.audit(null, after, 'chat.tool.expired', { waitedFor: inv.state === 'pending' ? 'caller' : 'reviewer', sideEffect: inv.side_effect });
    return true;
  }

  /** Expires the cards nobody decided in time (the `chat.sweep` job, and each read of a conversation's cards). */
  async expire(tenantId: string, conversationId?: string): Promise<number> {
    const q = this.db('chat_invocations').where({ tenant_id: tenantId }).whereIn('state', ['pending', 'held']).andWhere('expires_at', '<=', Date.now());
    if (conversationId) q.andWhere({ conversation_id: conversationId });
    let n = 0;
    for (const r of (await q.limit(500)) as InvocationRow[]) if (await this.expireOne(rowFrom(r))) n++;
    return n;
  }

  // ---------- B-4004: @agent ----------

  async startAgent(p: Principal, conversationId: string, input: { agent: string; input: string; context?: number | undefined; budgets?: Partial<AgentBudgets> | undefined; profile?: string | undefined; parentId?: string | null | undefined }, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const sc = await this.scope(p, conversationId, input.profile ?? null);
    const c = sc.c!;
    const entry = (await this.offered(p, sc)).agents.find((e) => e.name === input.agent);
    if (!entry) throw notFound('Agent');
    const said = await this.guardText(p, c, input.input);
    // The checks a run starts with (the agent's profile, the label against its ceiling), before the conversation changes.
    await this.s.agents.checkStart(p, { agent: entry.id, label: c.label });
    // The turns the person lets the agent read: only those within the agent's ceiling.
    const turns = input.context ? await this.s.chat.recentTurns(c, input.context, entry.label) : [];
    const task = turns.length ? `Recent turns of the conversation you were called from, for context:\n${turns.map((t) => `${t.role === 'user' ? 'Person' : 'Assistant'}: ${t.content}`).join('\n\n')}\n\nThe request:\n${said}` : said;
    const id = ulid();
    const turn = await this.s.chat.addInvocationTurn(p, c, { kind: 'agent', invocationId: id, text: `@${entry.name} ${said}`, label: c.label, parentId: input.parentId });
    let inv = await this.insert(p, c, id, { kind: 'agent', entry, profile: sc.profile?.name ?? null, label: c.label, args: said, turn });
    try {
      const run = await this.s.agents.start(p, { agent: entry.id, input: task, label: c.label, ...(input.budgets ? { budgets: input.budgets } : {}) }, { caller: { kind: CHAT_CALLER, id, node: '' }, conversationId: c.id });
      await this.db('chat_invocations').where({ id }).update({ run_kind: 'agent-run', run_id: run.id });
      inv = { ...inv, run_kind: 'agent-run', run_id: run.id };
      await this.s.audit.append({ tenantId: c.tenant_id, action: 'agent.run.started', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { run: run.id, agent: run.agent, version: run.agentVersion }, label: run.label, detail: { via: 'chat', conversation: c.id, invocation: id, budgets: run.budgets, contextTurns: turns.length }, ...(o.traceId ? { traceId: o.traceId } : {}) });
    } catch (err) {
      const error = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      inv = (await this.move(inv, ['running'], { state: 'failed', error: error.slice(0, 1000) })) ?? inv;
      await this.withdraw(inv, 'failed', error);
      await this.audit(p, inv, 'chat.agent.failed', { reason: error }, o);
      return this.view(p, inv);
    }
    this.s.chat.notify(c, 'chat.invocation', { conversationId: c.id, invocationId: id, kind: 'agent', state: 'running', messageId: turn.messageId });
    // A run that ended before its invocation named it is picked up here.
    await this.callerDone(c.tenant_id, id);
    return this.view(p, (await this.byId(c.tenant_id, id))!);
  }

  // ---------- B-4009: /workflow ----------

  async startWorkflow(p: Principal, conversationId: string, input: { workflow: string; input: Record<string, unknown>; profile?: string | undefined; parentId?: string | null | undefined }, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const sc = await this.scope(p, conversationId, input.profile ?? null);
    const c = sc.c!;
    const w = (await this.offered(p, sc)).workflows.find((x) => x.name === input.workflow || x.id === input.workflow);
    if (!w) throw notFound('Workflow');
    // A run carries its workflow's label: the turn is labelled at the higher of that and the conversation's.
    const label = highest(c.label, w.label);
    const id = ulid();
    // The run starts first: it validates the input against the trigger, and a refusal leaves the conversation as it was.
    const run = await this.s.workflows.start(p, w.id, { input: input.input, dry: false, trigger: 'chat', caller: { kind: CHAT_CALLER, id, node: '' }, conversationId: c.id });
    let turn: { userMessageId: string; messageId: string };
    try {
      turn = await this.s.chat.addInvocationTurn(p, c, { kind: 'workflow', invocationId: id, text: `Started the workflow ${w.name} with ${JSON.stringify(input.input)}`, label: highest(label, run.label), parentId: input.parentId });
    } catch (err) {
      await this.s.workflows.cancel(p, run.id).catch(() => undefined);
      throw err;
    }
    await this.insert(p, c, id, { kind: 'workflow', entry: { id: w.id, name: w.name, version: String(run.version ?? w.version ?? '') }, profile: sc.profile?.name ?? null, label: highest(label, run.label), args: input.input, turn });
    await this.db('chat_invocations').where({ id }).update({ run_kind: 'workflow-run', run_id: run.id });
    await this.s.audit.append({ tenantId: c.tenant_id, action: 'workflow.run.started', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { workflow: run.workflow_id, run: run.id }, label: run.label, detail: { version: run.version, via: 'chat', conversation: c.id, invocation: id }, ...(o.traceId ? { traceId: o.traceId } : {}) });
    this.s.chat.notify(c, 'chat.invocation', { conversationId: c.id, invocationId: id, kind: 'workflow', state: 'running', messageId: turn.messageId });
    // A short run may have ended before its invocation was recorded.
    await this.callerDone(c.tenant_id, id);
    return this.view(p, (await this.byId(c.tenant_id, id))!);
  }

  // ---------- runs ending, cancel, held calls ----------

  /** The run an invocation started ended (or stopped at its budget): its result joins the conversation. */
  async callerDone(tenantId: string, id: string): Promise<void> {
    const inv = await this.byId(tenantId, id);
    if (!inv || !inv.run_id || ENDED.includes(inv.state)) return;
    const end = async (state: InvocationState, error: string | null) => {
      const after = await this.move(inv, ['running', 'waiting', 'budget'], { state, error: error?.slice(0, 1000) ?? null });
      if (!after) return;
      await this.withdraw(after, state === 'failed' ? 'failed' : 'withdrawn', error);
      await this.audit(null, after, `chat.${inv.kind}.${state}`, { run: inv.run_id, reason: error });
    };
    const owner = await loadPrincipal(this.s, inv.tenant_id, inv.user_id, {});
    const ws = inv.workspace_id ? await this.s.tenants.workspace(inv.tenant_id, inv.workspace_id) : undefined;
    // The result joins the conversation only within what its owner may read there.
    const ceiling = owner ? (ws ? lower(owner.clearance, ws.label_ceiling) : owner.clearance) : 'public';
    if (inv.run_kind === 'agent-run') {
      const r = await this.s.agents.stateForStep(tenantId, inv.run_id);
      if (!r) return end('failed', 'The run no longer exists.');
      if (r.state === 'budget') return void (await this.move(inv, ['running', 'waiting'], { state: 'budget', error: r.error }));
      if (r.state === 'cancelled') return end('cancelled', r.error ?? 'Cancelled.');
      if (r.state === 'failed') return end('failed', r.error ?? 'The run failed.');
      if (r.state !== 'succeeded') return;
      if (labelRank(r.label) > labelRank(ceiling)) return end('failed', `The answer is ${r.label}, above what this conversation may hold (${ceiling}). Open the run in Runs.`);
      const label = highest(inv.label, r.label);
      const after = await this.move(inv, ['running', 'waiting', 'budget'], { state: 'succeeded', label, error: null });
      if (!after) return;
      await this.s.chat.settleInvocationTurn(this.conv(inv), { userMessageId: inv.user_message_id, messageId: inv.message_id, state: 'complete', content: r.output ?? '', label });
      await this.audit(null, after, 'chat.agent.succeeded', { run: inv.run_id, tokens: r.tokens });
      return;
    }
    const r = await this.s.workflows.resultForCaller(tenantId, inv.run_id);
    if (!r) return end('failed', 'The run no longer exists.');
    if (r.state === 'cancelled') return end('cancelled', r.error ?? 'Cancelled.');
    if (r.state === 'rejected') return end('rejected', r.error ?? 'An approval was rejected.');
    if (r.state === 'failed') return end('failed', r.error ?? 'The run failed.');
    if (r.state !== 'succeeded') return;
    if (labelRank(r.label) > labelRank(ceiling)) return end('failed', `The result is ${r.label}, above what this conversation may hold (${ceiling}). Open the run in Workflows.`);
    const label = highest(inv.label, r.label);
    const after = await this.move(inv, ['running', 'waiting'], { state: 'succeeded', label, result: await this.seal(inv, 'result', r.output), error: null });
    if (!after) return;
    await this.s.chat.settleInvocationTurn(this.conv(inv), { userMessageId: inv.user_message_id, messageId: inv.message_id, state: 'complete', tool: { name: `workflow:${inv.entry_name}`, expression: JSON.stringify(await this.open<unknown>(inv, 'args', {})), output: { run: inv.run_id, output: r.output } }, label });
    await this.audit(null, after, 'chat.workflow.succeeded', { run: inv.run_id });
  }

  /** Cancels the run an invocation started, or withdraws a tool call that has not run. */
  async cancel(p: Principal, conversationId: string, id: string, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const c = await this.s.chat.conversation(p, conversationId);
    const inv = await this.row(c, id);
    if (ENDED.includes(inv.state)) throw conflict(`This call is already ${inv.state}.`);
    if (inv.kind === 'tool') {
      const after = await this.move(inv, ['pending', 'held'], { state: 'cancelled', error: 'Withdrawn by the person who made the call. Nothing ran.' });
      if (!after) throw conflict('The call is running; it cannot be withdrawn now.');
      await this.withdraw(after, 'withdrawn', after.error);
      await this.audit(p, after, 'chat.tool.cancelled', { was: inv.state }, o);
      return this.view(p, after);
    }
    if (inv.run_kind === 'agent-run') {
      await this.s.agents.cancel(p, inv.run_id!);
      await this.s.audit.append({ tenantId: c.tenant_id, action: 'agent.run.cancelled', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { run: inv.run_id }, detail: { via: 'chat', conversation: c.id }, ...(o.traceId ? { traceId: o.traceId } : {}) });
    } else {
      const run = await this.s.workflows.cancel(p, inv.run_id!);
      await this.s.audit.append({ tenantId: c.tenant_id, action: 'workflow.run.cancelled', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { workflow: run.workflow_id, run: run.id }, label: run.label, detail: { via: 'chat', conversation: c.id }, ...(o.traceId ? { traceId: o.traceId } : {}) });
    }
    await this.callerDone(c.tenant_id, inv.id);
    return this.view(p, (await this.byId(c.tenant_id, inv.id))!);
  }

  /** B-4009: a call held anywhere in the run's chain, decided from the conversation's card with the rules of its place. */
  async decideHeld(p: Principal, conversationId: string, id: string, b: { node: string; decision: 'approve' | 'reject'; note: string | null; step?: number | undefined; approval?: string | undefined }, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const c = await this.s.chat.conversation(p, conversationId);
    const inv = await this.row(c, id);
    const chain = await this.chainOf(inv);
    if (!chain) throw conflict('This call started no run, so nothing is held in it.');
    const out = await decideHeld(this.s, p, chain.id, b.node, b, o.ip ?? null);
    const trace = o.traceId ? { traceId: o.traceId } : {};
    if (out.held.at.kind === 'workflow-run' && 'workflow' in out && out.workflow) {
      await this.s.audit.append({ tenantId: p.tenantId, action: out.workflow.state === 'approved' ? 'workflow.approval.approved' : 'workflow.approval.rejected', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { workflow: out.workflow.workflowId, run: out.workflow.run, approval: out.workflow.approval }, label: out.workflow.label, detail: { reason: b.note ? 'given' : null, via: 'chat' }, ...trace });
    }
    await this.s.audit.append({ tenantId: p.tenantId, action: 'chain.held.decided', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { chain: chain.id, node: b.node, conversation: c.id, invocation: inv.id, ...(out.held.at.kind === 'agent-run' ? { run: out.held.at.run, step: out.held.at.step } : { run: out.held.at.run, approval: out.held.at.approval }) }, label: inv.label, detail: { decision: b.decision, tool: out.held.tool, sideEffect: out.held.sideEffect, depth: out.held.path.length - 1, path: out.held.path.map((x) => `${x.kind}:${x.name ?? x.ref}`), via: 'chat' }, ...trace });
    this.s.chat.notify(c, 'chat.invocation', { conversationId: c.id, invocationId: inv.id, kind: inv.kind, state: inv.state, messageId: inv.message_id });
    return this.view(p, (await this.byId(c.tenant_id, inv.id))!);
  }

  private async chainOf(inv: InvocationRow): Promise<{ id: string; node: string | null } | null> {
    if (!inv.run_id || !inv.run_kind) return null;
    const r = (await this.db(inv.run_kind === 'agent-run' ? 'agent_runs' : 'workflow_runs').where({ tenant_id: inv.tenant_id, id: inv.run_id }).first('chain_id', 'chain_node')) as { chain_id: string | null; chain_node: string | null } | undefined;
    return r?.chain_id ? { id: r.chain_id, node: r.chain_node } : null;
  }

  // ---------- views ----------

  async list(p: Principal, conversationId: string) {
    const c = await this.s.chat.conversation(p, conversationId);
    await this.expire(c.tenant_id, c.id);
    const rows = ((await this.db('chat_invocations').where({ tenant_id: c.tenant_id, conversation_id: c.id }).orderBy('created_at').limit(500)) as InvocationRow[]).map(rowFrom);
    const invocations = [];
    for (const r of rows) invocations.push(await this.view(p, r));
    return { invocations, skills: await this.skillsView(p, c) };
  }

  private async view(p: Principal, inv: InvocationRow) {
    const cleared = clears(p.clearance, inv.label);
    const args = cleared ? await this.open<unknown>(inv, 'args', null) : null;
    let state = inv.state;
    let run: Record<string, unknown> | null = null;
    let held: (Omit<HeldCall, 'path'> & { path: { kind: string; name: string | null; depth: number }[] })[] = [];
    if (inv.run_id && inv.run_kind) {
      const chain = await this.chainOf(inv);
      if (inv.run_kind === 'agent-run') {
        const v = await this.s.agents.view(p, inv.run_id).catch(() => null);
        if (v) run = { kind: 'agent-run', id: v.id, state: v.state, chain: v.chain?.id ?? null, usage: { steps: v.usage.steps, tokens: v.usage.tokens, toolCalls: v.usage.toolCalls }, budgets: v.budgets, error: v.error, steps: v.steps.map((x) => ({ n: x.n, lane: x.lane, title: x.title, state: x.state })) };
      } else {
        const v = await this.s.workflows.runView(p, inv.run_id).catch(() => null);
        if (v) run = { kind: 'workflow-run', id: v.id, state: v.state, chain: v.chain?.id ?? null, workflowId: v.workflowId, usage: null, budgets: null, error: v.error, steps: v.steps.map((x, i) => ({ n: i + 1, lane: 'do', title: v.graph.nodes.find((g) => g.id === x.nodeId)?.title ?? x.nodeId, state: x.state })) };
      }
      if (!ENDED.includes(state) && run) {
        if (run.state === 'waiting') state = 'waiting';
        else if (run.state === 'budget') state = 'budget';
      }
      if (!ENDED.includes(state)) held = (await rootHeld(this.s, p, chain)).map((h) => ({ node: h.node, path: h.path.map((x) => ({ kind: x.kind, name: x.name, depth: x.depth })), at: h.at, tool: h.tool, sideEffect: h.sideEffect, since: h.since, approvers: h.approvers, canDecide: h.canDecide }));
    }
    const reviewer = inv.reviewer_id ? ((await this.db('users').where({ id: inv.reviewer_id }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined) : undefined;
    const flag = inv.flag_id ? ((await this.db('guard_flags').where({ id: inv.flag_id }).first('number')) as { number: number } | undefined) : undefined;
    return {
      id: inv.id,
      kind: inv.kind,
      name: inv.entry_name,
      version: inv.entry_version,
      sideEffect: inv.side_effect,
      label: inv.label,
      state,
      arguments: inv.kind === 'agent' ? null : args,
      input: inv.kind === 'agent' ? (args as string | null) : null,
      fromText: !!inv.from_text,
      result: cleared && inv.result ? await this.open<unknown>(inv, 'result', null) : null,
      error: inv.error,
      userMessageId: inv.user_message_id,
      messageId: inv.message_id,
      approval: inv.needs
        ? {
            needs: inv.needs.split(','),
            caller: inv.caller_decision ? { decision: inv.caller_decision, at: inv.caller_decided_at } : null,
            reviewer: inv.reviewer_decision ? { decision: inv.reviewer_decision, by: reviewer ? reviewer.display_name || reviewer.username : null, at: inv.reviewer_decided_at } : null,
            flag: flag ? `F-${flag.number}` : null,
            reason: inv.hold_reason,
            expiresAt: inv.expires_at
          }
        : null,
      run,
      held,
      createdAt: inv.created_at,
      updatedAt: inv.updated_at
    };
  }

  // ---------- B-4005: +skill ----------

  private async skillsView(p: Principal, c: ConversationRow) {
    const rows = (await this.db('chat_conversation_skills').where({ conversation_id: c.id }).orderBy('added_at')) as { skill: string; mode: 'sticky' | 'once'; added_at: number }[];
    if (!rows.length) return [];
    const sc = await this.scope(p, c.id, null);
    const offered = (await this.offered(p, sc)).skills;
    return rows.map((r) => {
      const e = offered.find((x) => x.name === r.skill);
      return { name: r.skill, version: e?.version ?? null, mode: r.mode, addedAt: Number(r.added_at), available: !!e, reason: e ? null : 'It is no longer offered in this conversation, so its instructions are left out.' };
    });
  }

  async addSkill(p: Principal, conversationId: string, name: string, mode: 'sticky' | 'once', profile: string | null, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const sc = await this.scope(p, conversationId, profile);
    const c = sc.c!;
    const e = (await this.offered(p, sc)).skills.find((x) => x.name === name);
    if (!e) throw notFound('Skill');
    const n = await this.db('chat_conversation_skills').where({ conversation_id: c.id, skill: e.name }).update({ mode });
    if (!n) await this.db('chat_conversation_skills').insert({ id: ulid(), tenant_id: c.tenant_id, conversation_id: c.id, skill: e.name, mode, added_by: p.userId, added_at: Date.now() });
    await this.s.audit.append({ tenantId: c.tenant_id, action: 'chat.skill.added', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { conversation: c.id, skill: e.name, version: e.version }, label: c.label, detail: { mode }, ...(o.traceId ? { traceId: o.traceId } : {}) });
    this.s.chat.notify(c, 'chat.skills', { conversationId: c.id });
    return { skills: await this.skillsView(p, c) };
  }

  async removeSkill(p: Principal, conversationId: string, name: string, o: { ip?: string | null; traceId?: string | undefined } = {}) {
    const c = await this.s.chat.conversation(p, conversationId);
    const n = await this.db('chat_conversation_skills').where({ conversation_id: c.id, skill: name }).delete();
    if (!n) throw notFound('Skill');
    await this.s.audit.append({ tenantId: c.tenant_id, action: 'chat.skill.removed', kind: 'admin', actor: actorFrom(p, o.ip ?? null), target: { conversation: c.id, skill: name }, label: c.label, ...(o.traceId ? { traceId: o.traceId } : {}) });
    this.s.chat.notify(c, 'chat.skills', { conversationId: c.id });
    return { skills: await this.skillsView(p, c) };
  }

  /**
   * The skills of a turn (`ChatService.turnSkills`): read when the turn starts, so a removed skill is out of the very
   * next one. Each skill loads with what it builds on (its closure), within its ceiling and the turn's profile's
   * allow-list; a `once` skill is removed once it has applied.
   */
  async turnSkills(p: Principal, c: ConversationRow, profile: ProfileRow, messageId: string): Promise<{ prompt: string; tools: string[] } | null> {
    const rows = (await this.db('chat_conversation_skills').where({ conversation_id: c.id }).orderBy('added_at')) as { id: string; skill: string; mode: 'sticky' | 'once' }[];
    if (!rows.length) return null;
    const allow = profile.chat_capabilities ?? {};
    const names = rows.filter((r) => this.allowed(allow.skills, r.skill)).map((r) => r.skill);
    const closure = await skillClosure(this.s.registry, { tenantId: c.tenant_id, workspaceId: c.workspace_id }, names);
    const loaded = closure.skills.filter((e) => labelRank(c.label) <= labelRank(e.label));
    const once = rows.filter((r) => r.mode === 'once' && loaded.some((e) => e.name === r.skill));
    if (once.length) {
      await this.db('chat_conversation_skills').whereIn('id', once.map((r) => r.id)).delete();
      this.s.chat.notify(c, 'chat.skills', { conversationId: c.id });
    }
    if (!loaded.length) return null;
    await this.s.audit.append({ tenantId: c.tenant_id, action: 'chat.skill.applied', kind: 'system', actor: actorFrom(p), target: { conversation: c.id, message: messageId }, label: c.label, detail: { skills: loaded.map((e) => `${e.name}@${e.version}`), once: once.map((r) => r.skill), profile: profile.name } });
    return {
      prompt: loaded.map((e) => `Skill ${e.name} ${e.version}:\n${String(e.definition.instructions ?? '')}`).join('\n\n'),
      tools: [...new Set(loaded.flatMap((e) => skillNames(e, 'tools')))].filter((t) => this.allowed(allow.tools, t))
    };
  }
}

/** Write, destructive and always-confirm tools wait for the caller's own approval (B-4003). */
function needsCaller(e: Pick<EntryRow, 'side_effect' | 'confirm'>): boolean {
  return (e.side_effect ?? 'read') !== 'read' || e.confirm === 'always';
}

const rowFrom = (r: InvocationRow): InvocationRow => ({
  ...r,
  from_text: r.from_text === true || (r.from_text as unknown) === 1 || (r.from_text as unknown) === '1' || (r.from_text as unknown) === 't',
  caller_decided_at: num(r.caller_decided_at),
  reviewer_decided_at: num(r.reviewer_decided_at),
  expires_at: num(r.expires_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** The budgets a person may ask for when they start an agent from chat: within the registry's maximum. */
export const CHAT_BUDGET_LIMITS = MAX_BUDGETS;
