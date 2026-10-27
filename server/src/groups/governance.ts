import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { mac } from '../vault/keyring.js';
import { GroupBudget, BUDGET_LIMITS } from './budget.js';
import { can, covers, customRights, GROUP_ROLES, ownsGroup, tierRights, type GroupRole } from './roles.js';
import { groupPrincipal } from './service-principal.js';
import type { Access, Ctx, GroupRow } from './service.js';
import { checkChoice, choiceFrom, choiceText, METHODS, QUORUM_KINDS, tally, type Choice, type Method, type QuorumKind, type Tally } from './tally.js';

/*
 * 1.9.0, Sprint 53 (B-174 to B-176): a group decides things together.
 *
 * Proposals (B-174). A member the group's governance settings allow (members, holders of a role or more, or owners
 * only; owners always may) drafts a proposal of one kind: free-form, change a group setting, add or remove a member,
 * give or take a role, change the group's rules, or spend from the group's budget (groups/budget.ts). Its title, text,
 * options and the action it would take are sealed together under the tenant's key with the proposal's id
 * (`group-proposal:<id>`) and carry the group's label, as a post does; they pass the `user-input` guardrail. A draft is
 * its author's to change, open or delete. Opening it fixes who may vote (the electorate: the members whose membership
 * is in effect then and who hold more than a guest's rights) and how long voting lasts (between the group's minimum
 * and maximum), and posts it for discussion in the group's linked conversation when it has one. States: draft → open →
 * closed (with an outcome: passed, rejected, or no quorum) → carried_out or failed, for a passed proposal of an
 * actionable kind.
 *
 * Voting (B-175, the methods in groups/tally.ts). Only the electorate votes, and a vote can be changed until close.
 * Public ballots name their voter, and members see who voted for what. Secret ballots do not: see `castSecret` and
 * docs/security.md for what the server keeps and what an administrator could still learn. Closing is lazy (the first
 * read after the closing time) and swept by the `groups.governance.tick` job, which also sends one reminder before
 * close to those who have not voted. The tally and its working go into the audit chain (`group.proposal.closed`).
 *
 * Carrying out (B-176). A passed proposal of an actionable kind is applied through the group's own services, as the
 * group: `groupPrincipal` stands as an owner of this group and nothing else, so the decision can do what an owner could,
 * and every rule of those services applies (the last owner stays, nobody is invited past a ban, the budget never goes
 * below zero). The group's owners may require their own confirmation first for some kinds. `carry_claimed_at` is set
 * by one conditional update, so a decision is carried out at most once. The result or the failure is kept on the
 * proposal and posted to the conversation.
 *
 * Without migrations 133 and 134 every read answers `available: false` and every change is refused with 503.
 */

export const PROPOSAL_KINDS = ['free', 'setting', 'member', 'role', 'rules', 'spend'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const ACTIONABLE_KINDS: readonly ProposalKind[] = ['setting', 'member', 'role', 'rules', 'spend'];
export const PROPOSAL_STATES = ['draft', 'open', 'closed', 'carried_out', 'failed'] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export const PROPOSE_MODES = ['members', 'role', 'owners'] as const;
export type ProposeMode = (typeof PROPOSE_MODES)[number];
export const GOVERNANCE_TICK_JOB = 'groups.governance.tick';
export const GOVERNANCE_LIMITS = { title: 200, body: 20_000, options: 20, optionLabel: 200, rules: 20_000, minHours: 1, maxHours: 2160, fractionDen: 100 } as const;
const TABLES = ['group_governance', 'group_proposals', 'group_proposal_electorate', 'group_ballots', 'group_vote_participation', 'group_vote_commitments', 'group_budgets', 'group_budget_entries'];
const SCHEMA_RECHECK_MS = 30_000;
const REMIND_MAX_MS = 24 * 3_600_000;

/** What a proposal of each kind would do, as validated when it is drafted. */
export const settingPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullable().optional(),
  visibility: z.enum(['public', 'private', 'hidden']).optional(),
  joinMode: z.enum(['open', 'request', 'invite']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  website: z.string().trim().max(500).nullable().optional(),
  memberLimit: z.number().int().min(1).max(1_000_000).nullable().optional()
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), 'Name at least one setting to change.');
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
export const ACTION_SCHEMAS = {
  free: z.object({}).strict(),
  setting: z.object({ patch: settingPatch }).strict(),
  member: z.object({ op: z.enum(['add', 'remove']), userId: id26 }).strict(),
  role: z.object({ userId: id26, role: z.enum(GROUP_ROLES).optional(), customRoleId: id26.nullable().optional() }).strict().refine((v) => !!v.role || !!v.customRoleId, 'Name a role or a custom role.'),
  rules: z.object({ rules: z.string().max(GOVERNANCE_LIMITS.rules) }).strict(),
  spend: z.object({ amountMinor: z.number().int().min(1).max(BUDGET_LIMITS.amountMinor), memo: z.string().trim().max(BUDGET_LIMITS.memo).optional() }).strict()
} as const;
type Action = Record<string, unknown>;

export interface Settings {
  propose: ProposeMode;
  proposeRole: string | null;
  method: Method;
  threshold: { num: number; den: number };
  quorum: { kind: QuorumKind; value: number };
  minHours: number;
  maxHours: number;
  defaultHours: number;
  secret: boolean;
  confirmKinds: ProposalKind[];
}

export const DEFAULT_SETTINGS: Settings = { propose: 'members', proposeRole: null, method: 'majority', threshold: { num: 2, den: 3 }, quorum: { kind: 'none', value: 0 }, minHours: 24, maxHours: 336, defaultHours: 72, secret: false, confirmKinds: [] };

interface Content {
  title: string;
  body: string;
  options: { id: string; label: string }[];
  action: Action;
}

export interface ProposalRow {
  id: string;
  tenant_id: string;
  group_id: string;
  workspace_id: string;
  kind: ProposalKind;
  state: ProposalState;
  content: string;
  label: Label;
  method: Method;
  threshold_num: number;
  threshold_den: number;
  quorum_kind: QuorumKind;
  quorum_value: number;
  secret: boolean;
  options: number;
  hours: number | null;
  opens_at: number | null;
  closes_at: number | null;
  reminded_at: number | null;
  closed_at: number | null;
  outcome: 'passed' | 'rejected' | 'no_quorum' | null;
  result: string | null;
  electorate: number;
  turnout: number;
  needs_confirmation: boolean;
  confirmed_by: string | null;
  confirmed_at: number | null;
  carry_claimed_at: number | null;
  carried_at: number | null;
  carried_result: string | null;
  failure: string | null;
  conversation_id: string | null;
  discussion_message_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

const n = (v: unknown) => (v == null ? null : Number(v));
const proposalFrom = (r: Record<string, unknown>): ProposalRow => ({
  ...(r as unknown as ProposalRow),
  threshold_num: Number(r.threshold_num),
  threshold_den: Number(r.threshold_den),
  quorum_value: Number(r.quorum_value),
  secret: !!r.secret && r.secret !== '0',
  options: Number(r.options),
  hours: n(r.hours),
  opens_at: n(r.opens_at),
  closes_at: n(r.closes_at),
  reminded_at: n(r.reminded_at),
  closed_at: n(r.closed_at),
  electorate: Number(r.electorate),
  turnout: Number(r.turnout),
  needs_confirmation: !!r.needs_confirmation && r.needs_confirmation !== '0',
  confirmed_at: n(r.confirmed_at),
  carry_claimed_at: n(r.carry_claimed_at),
  carried_at: n(r.carried_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const notInstalled = () => new HttpProblem(503, 'Not installed', 'Group governance needs the database migrations 133_group_proposals and 134_group_votes, which have not been applied.', { extensions: { reason: 'migration_pending' } });
const SERVICE_ACTOR: AuditActor = { service: 'groups.governance' };
const isSqlite = (db: { client: { config: { client?: unknown } } }) => /sqlite/.test(String(db.client.config.client));

/** The proposal's input as the route validated it. */
export interface ProposalInput {
  kind: ProposalKind;
  title: string;
  body?: string | undefined;
  options?: string[] | undefined;
  action?: Action | undefined;
  method?: Method | undefined;
  threshold?: { num: number; den: number } | undefined;
  quorum?: { kind: QuorumKind; value: number } | undefined;
  secret?: boolean | undefined;
  hours?: number | undefined;
}

export class GroupGovernance {
  readonly budget: GroupBudget;
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {
    this.budget = new GroupBudget(s);
  }

  private get db() {
    return this.s().db;
  }

  // ---------- schema ----------

  /** Whether migrations 133 and 134 are applied; a negative answer is checked again every 30 s. */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.db.schema.hasTable(name))) { ok = false; break; }
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  private async need(): Promise<void> {
    if (!(await this.installed())) throw notInstalled();
  }

  // ---------- settings ----------

  async settings(groupId: string): Promise<Settings & { rules: string | null; updatedAt: number | null; updatedBy: string | null }> {
    const r = (await this.db('group_governance').where({ group_id: groupId }).first()) as Record<string, unknown> | undefined;
    if (!r) return { ...DEFAULT_SETTINGS, rules: null, updatedAt: null, updatedBy: null };
    const kinds = JSON.parse(String(r.confirm_kinds ?? '[]')) as string[];
    const rules = r.rules ? ((await this.s().keys.open(String(r.tenant_id), String(r.rules), `group-rules:${groupId}`)) ?? null) : null;
    return {
      propose: (PROPOSE_MODES as readonly string[]).includes(String(r.propose)) ? (r.propose as ProposeMode) : 'members',
      proposeRole: (r.propose_role as string | null) ?? null,
      method: (METHODS as readonly string[]).includes(String(r.method)) ? (r.method as Method) : 'majority',
      threshold: { num: Number(r.threshold_num), den: Number(r.threshold_den) },
      quorum: { kind: (QUORUM_KINDS as readonly string[]).includes(String(r.quorum_kind)) ? (r.quorum_kind as QuorumKind) : 'none', value: Number(r.quorum_value) },
      minHours: Number(r.min_hours),
      maxHours: Number(r.max_hours),
      defaultHours: Number(r.default_hours),
      secret: !!r.secret && r.secret !== '0',
      confirmKinds: kinds.filter((k): k is ProposalKind => (ACTIONABLE_KINDS as readonly string[]).includes(k)),
      rules,
      updatedAt: n(r.updated_at),
      updatedBy: (r.updated_by as string | null) ?? null
    };
  }

  /** Whether the caller may draft a proposal in the group under its settings. Owners always may. */
  async mayPropose(a: Access, st: Pick<Settings, 'propose' | 'proposeRole'>): Promise<boolean> {
    if (!a.read || a.group.parent_id || a.group.state !== 'active') return false;
    if (ownsGroup(a.rights)) return true;
    if (!a.role || !can(a, 'post')) return false;
    if (st.propose === 'members') return true;
    if (st.propose === 'owners' || !st.proposeRole) return false;
    // A role, or more: holding at least the rights that role carries.
    if ((GROUP_ROLES as readonly string[]).includes(st.proposeRole)) return covers(a.rights, tierRights(st.proposeRole as GroupRole));
    if (a.customRole?.id === st.proposeRole) return true;
    const custom = await this.s().groups.roles.row(a.group.id, st.proposeRole);
    return !!custom && covers(a.rights, customRights(custom));
  }

  /** The group's governance for whoever reads it: the settings, its rules, and what the caller may do. */
  async view(p: Principal, groupId: string) {
    const s = this.s();
    const a = await s.groups.require(p, groupId, 'read');
    if (!(await this.installed())) return { available: false as const, groupId };
    const st = await this.settings(groupId);
    return { available: true as const, groupId, channel: !!a.group.parent_id, ...st, canPropose: await this.mayPropose(a, st), canManage: can(a, 'settings') && !a.group.parent_id, canConfirm: ownsGroup(a.rights), kinds: PROPOSAL_KINDS, methods: METHODS };
  }

  async updateSettings(ctx: Ctx, groupId: string, patch: Partial<Settings> & { rules?: string | null | undefined }) {
    await this.need();
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'settings');
    const g = a.group;
    if (g.parent_id) throw new HttpProblem(422, 'Not for a channel', 'Governance belongs to the group, not to its channels.', { extensions: { step: 'parent' } });
    const before = await this.settings(g.id);
    const next: Settings = { ...before, ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'rules')) } as Settings;
    if (next.minHours > next.maxHours) throw new HttpProblem(422, 'Voting times out of order', 'The shortest vote cannot be longer than the longest.', { extensions: { step: 'hours' } });
    if (next.defaultHours < next.minHours || next.defaultHours > next.maxHours) throw new HttpProblem(422, 'Default outside the range', `The default length of a vote is between ${next.minHours} and ${next.maxHours} hours.`, { extensions: { step: 'hours' } });
    if (next.threshold.num < 1 || next.threshold.num > next.threshold.den || next.threshold.den > GOVERNANCE_LIMITS.fractionDen || next.threshold.num * 2 <= next.threshold.den) throw new HttpProblem(422, 'Not a supermajority', 'A supermajority is a fraction above one half, at most one.', { extensions: { step: 'threshold' } });
    if (next.quorum.kind === 'share' && (next.quorum.value < 0 || next.quorum.value > 100)) throw new HttpProblem(422, 'Not a share', 'A quorum share is a percentage from 0 to 100.', { extensions: { step: 'quorum' } });
    if (next.propose === 'role') {
      if (!next.proposeRole) throw new HttpProblem(422, 'Name a role', 'Say which role may propose (that role, and anyone holding at least its rights).', { extensions: { step: 'propose' } });
      if (!(GROUP_ROLES as readonly string[]).includes(next.proposeRole) && !(await s.groups.roles.row(g.id, next.proposeRole))) throw notFound('Role');
    } else next.proposeRole = null;
    const t = Date.now();
    const rules = patch.rules === undefined ? undefined : patch.rules?.trim() ? await this.screen(ctx.p, g, patch.rules.trim(), 'rules') : null;
    const cols: Record<string, unknown> = {
      propose: next.propose, propose_role: next.proposeRole, method: next.method, threshold_num: next.threshold.num, threshold_den: next.threshold.den,
      quorum_kind: next.quorum.kind, quorum_value: Math.floor(next.quorum.value), min_hours: next.minHours, max_hours: next.maxHours, default_hours: next.defaultHours,
      secret: next.secret, confirm_kinds: JSON.stringify([...new Set(next.confirmKinds)].filter((k) => (ACTIONABLE_KINDS as readonly string[]).includes(k))), updated_by: ctx.p.userId, updated_at: t,
      ...(rules !== undefined ? { rules: rules ? await s.keys.seal(g.tenant_id, rules, `group-rules:${g.id}`) : null } : {})
    };
    await this.upsert(g, cols, t);
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    const plain = ({ rules: _r, updatedAt: _u, updatedBy: _b, ...x }: Awaited<ReturnType<GroupGovernance['settings']>>) => x;
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.governance.updated', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, workspace: g.workspace_id }, detail: { changed, before: plain(before), after: plain(await this.settings(g.id)), ...(rules !== undefined ? { rulesChanged: true } : {}) }, label: g.label, traceId: ctx.traceId ?? null });
    return this.view(ctx.p, g.id);
  }

  private async upsert(g: Pick<GroupRow, 'id' | 'tenant_id'>, cols: Record<string, unknown>, t: number): Promise<void> {
    const has = await this.db('group_governance').where({ group_id: g.id }).first('group_id');
    if (has) await this.db('group_governance').where({ group_id: g.id }).update(cols);
    else {
      const d = DEFAULT_SETTINGS;
      await this.db('group_governance').insert({ group_id: g.id, tenant_id: g.tenant_id, propose: d.propose, propose_role: null, method: d.method, threshold_num: d.threshold.num, threshold_den: d.threshold.den, quorum_kind: d.quorum.kind, quorum_value: d.quorum.value, min_hours: d.minHours, max_hours: d.maxHours, default_hours: d.defaultHours, secret: d.secret, confirm_kinds: '[]', rules: null, created_at: t, ...cols });
    }
  }

  /** Changes the group's rules (holders of `settings`, or the group carrying out a decision of kind `rules`). */
  async setRules(ctx: Ctx, groupId: string, text: string) {
    await this.need();
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'settings');
    const g = a.group;
    const t = Date.now();
    const rules = text.trim() ? await this.screen(ctx.p, g, text.trim(), 'rules') : null;
    await this.upsert(g, { rules: rules ? await s.keys.seal(g.tenant_id, rules, `group-rules:${g.id}`) : null, updated_by: ctx.p.userId, updated_at: t }, t);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.governance.updated', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, workspace: g.workspace_id }, detail: { changed: ['rules'], rulesChanged: true, length: rules?.length ?? 0 }, label: g.label, traceId: ctx.traceId ?? null });
    return { rules: rules ?? null };
  }

  /** The `user-input` guardrail on what a member writes into a proposal or the rules. */
  private async screen(p: Principal, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, text: string, field: string): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text, label: g.label, principal: p, source: { kind: 'group', id: g.id }, meta: { objectType: 'group-proposal', field, group: g.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The text was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action, field } });
    return d.action === 'redact' ? d.text : text;
  }

  // ---------- proposals ----------

  async row(tenantId: string, id: string): Promise<ProposalRow | null> {
    const r = (await this.db('group_proposals').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? proposalFrom(r) : null;
  }

  private async content(pr: Pick<ProposalRow, 'tenant_id' | 'id' | 'content'>): Promise<Content> {
    const text = await this.s().keys.open(pr.tenant_id, pr.content, `group-proposal:${pr.id}`);
    try {
      return JSON.parse(text ?? '') as Content;
    } catch {
      return { title: '', body: '', options: [], action: {} };
    }
  }

  /** Validates the kind's action and what it names, as the group stands now. */
  private async checkAction(g: GroupRow, kind: ProposalKind, raw: Action | undefined): Promise<Action> {
    const s = this.s();
    const parsed = ACTION_SCHEMAS[kind].safeParse(raw ?? {});
    if (!parsed.success) throw new HttpProblem(422, 'Not a valid action', parsed.error.issues.map((i) => `${i.path.join('.') || 'action'}: ${i.message}`).join('; '), { extensions: { step: 'action', kind } });
    const action = parsed.data as Action;
    if (kind === 'member' || kind === 'role') {
      const userId = String(action.userId);
      const u = await this.db('users').where({ tenant_id: g.tenant_id, id: userId }).first('id');
      if (!u) throw new HttpProblem(422, 'No such person', 'There is no user with that id in this tenant.', { extensions: { step: 'action' } });
      const member = await s.groups.member(g.id, userId);
      if (kind === 'role' && !member) throw new HttpProblem(422, 'Not a member', 'A role is given to a member of the group.', { extensions: { step: 'action' } });
      if (kind === 'member' && action.op === 'remove' && !member) throw new HttpProblem(422, 'Not a member', 'The person is not a member of the group.', { extensions: { step: 'action' } });
      if (kind === 'member' && action.op === 'add' && member) throw new HttpProblem(422, 'Already a member', 'The person is already a member of the group.', { extensions: { step: 'action' } });
      if (kind === 'role' && action.customRoleId && !(await s.groups.roles.row(g.id, String(action.customRoleId)))) throw notFound('Role');
    }
    if (kind === 'spend' && !(await this.budget.row(g.id))) throw new HttpProblem(422, 'No budget', 'The group has no budget yet: an owner sets its currency first.', { extensions: { step: 'budget' } });
    return action;
  }

  private checkMethod(kind: ProposalKind, method: Method, options: string[]): void {
    if (ACTIONABLE_KINDS.includes(kind) && (method === 'approval' || method === 'ranked')) throw new HttpProblem(422, 'Yes or no', 'A proposal that would change something is decided yes or no: by majority or supermajority.', { extensions: { step: 'method' } });
    if ((method === 'approval' || method === 'ranked') && options.length < 2) throw new HttpProblem(422, 'Options needed', 'Approval and ranked-choice votes need at least two options.', { extensions: { step: 'options' } });
    if ((method === 'majority' || method === 'supermajority') && options.length) throw new HttpProblem(422, 'No options', 'A yes-or-no vote has no options; use approval or ranked choice to choose between options.', { extensions: { step: 'options' } });
  }

  private async sealContent(p: Principal, g: GroupRow, id: string, input: { title: string; body: string; options: string[] }, action: Action): Promise<string> {
    const title = await this.screen(p, g, input.title.trim(), 'title');
    const body = input.body.trim() ? await this.screen(p, g, input.body.trim(), 'body') : '';
    const options: Content['options'] = [];
    for (const [i, label] of input.options.entries()) options.push({ id: `o${i + 1}`, label: await this.screen(p, g, label.trim(), 'option') });
    const act = { ...action };
    if (typeof act.rules === 'string' && act.rules.trim()) act.rules = await this.screen(p, g, act.rules.trim(), 'rules');
    if (typeof act.memo === 'string' && act.memo.trim()) act.memo = await this.screen(p, g, act.memo.trim(), 'memo');
    const patch = act.patch as Record<string, unknown> | undefined;
    if (patch && typeof patch.description === 'string' && patch.description.trim()) act.patch = { ...patch, description: await this.screen(p, g, patch.description.trim(), 'description') };
    const content: Content = { title, body, options, action: act };
    return this.s().keys.seal(g.tenant_id, JSON.stringify(content), `group-proposal:${id}`);
  }

  async create(ctx: Ctx, groupId: string, input: ProposalInput) {
    await this.need();
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'read');
    const g = a.group;
    if (g.parent_id) throw new HttpProblem(422, 'Not for a channel', 'Proposals belong to the group, not to its channels.', { extensions: { step: 'parent' } });
    if (g.state !== 'active') throw conflict('The group is not open for proposals.');
    const st = await this.settings(g.id);
    if (!(await this.mayPropose(a, st))) throw forbidden(st.propose === 'owners' ? 'In this group only its owners make proposals.' : st.propose === 'role' ? 'In this group proposals are made by holders of a role you do not hold.' : 'Join the group to make a proposal.', { step: 'governance', propose: st.propose });
    const method = input.method ?? (ACTIONABLE_KINDS.includes(input.kind) && (st.method === 'approval' || st.method === 'ranked') ? 'majority' : st.method);
    const options = (input.options ?? []).map((o) => o.trim()).filter(Boolean);
    this.checkMethod(input.kind, method, options);
    const action = await this.checkAction(g, input.kind, input.action);
    const threshold = input.threshold ?? st.threshold;
    if (threshold.num * 2 <= threshold.den || threshold.num > threshold.den) throw new HttpProblem(422, 'Not a supermajority', 'A supermajority is a fraction above one half, at most one.', { extensions: { step: 'threshold' } });
    const quorum = input.quorum ?? st.quorum;
    if (input.hours !== undefined && (input.hours < st.minHours || input.hours > st.maxHours)) throw new HttpProblem(422, 'Voting time out of range', `Voting in this group lasts between ${st.minHours} and ${st.maxHours} hours.`, { extensions: { step: 'hours', min: st.minHours, max: st.maxHours } });
    const id = ulid();
    const content = await this.sealContent(ctx.p, g, id, { title: input.title, body: input.body ?? '', options }, action);
    const t = Date.now();
    await this.db('group_proposals').insert({
      id, tenant_id: g.tenant_id, group_id: g.id, workspace_id: g.workspace_id, kind: input.kind, state: 'draft', content, label: g.label, method,
      threshold_num: threshold.num, threshold_den: threshold.den, quorum_kind: quorum.kind, quorum_value: Math.floor(quorum.value), secret: input.secret ?? st.secret,
      options: options.length, hours: input.hours ?? null, electorate: 0, turnout: 0, needs_confirmation: false, created_by: ctx.p.userId, created_at: t, updated_at: t
    });
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.proposal.created', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: id, workspace: g.workspace_id }, detail: { kind: input.kind, method, secret: input.secret ?? st.secret, options: options.length }, label: g.label, traceId: ctx.traceId ?? null });
    s.groups.room(g, 'group.proposal.created', { proposalId: id });
    return this.get(ctx.p, id);
  }

  /** A proposal and the caller's standing in its group; 404 when they may not read it. */
  private async load(p: Principal, id: string): Promise<{ pr: ProposalRow; a: Access }> {
    await this.need();
    const pr = await this.row(p.tenantId, id);
    if (!pr) throw notFound('Proposal');
    const a = await this.s().groups.accessOrNull(p, pr.group_id);
    if (!a?.read) throw notFound('Proposal');
    // A draft is its author's, and the owners'.
    if (pr.state === 'draft' && pr.created_by !== p.userId && !ownsGroup(a.rights)) throw notFound('Proposal');
    return { pr, a };
  }

  async update(ctx: Ctx, id: string, input: Partial<ProposalInput>) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    if (pr.created_by !== ctx.p.userId) throw forbidden('Only its author changes a draft.', { step: 'author' });
    if (pr.state !== 'draft') throw conflict('Only a draft can be changed; voting has started.');
    const g = a.group;
    const st = await this.settings(g.id);
    const before = await this.content(pr);
    const kind = input.kind ?? pr.kind;
    const method = input.method ?? pr.method;
    const options = input.options !== undefined ? input.options.map((o) => o.trim()).filter(Boolean) : before.options.map((o) => o.label);
    this.checkMethod(kind, method, options);
    const action = await this.checkAction(g, kind, input.action ?? (input.kind && input.kind !== pr.kind ? {} : before.action));
    const threshold = input.threshold ?? { num: pr.threshold_num, den: pr.threshold_den };
    if (threshold.num * 2 <= threshold.den || threshold.num > threshold.den) throw new HttpProblem(422, 'Not a supermajority', 'A supermajority is a fraction above one half, at most one.', { extensions: { step: 'threshold' } });
    const quorum = input.quorum ?? { kind: pr.quorum_kind, value: pr.quorum_value };
    if (input.hours !== undefined && (input.hours < st.minHours || input.hours > st.maxHours)) throw new HttpProblem(422, 'Voting time out of range', `Voting in this group lasts between ${st.minHours} and ${st.maxHours} hours.`, { extensions: { step: 'hours', min: st.minHours, max: st.maxHours } });
    const content = await this.sealContent(ctx.p, g, pr.id, { title: input.title ?? before.title, body: input.body ?? before.body, options }, action);
    const n = await this.db('group_proposals').where({ id: pr.id, state: 'draft' }).update({ kind, method, content, options: options.length, threshold_num: threshold.num, threshold_den: threshold.den, quorum_kind: quorum.kind, quorum_value: Math.floor(quorum.value), secret: input.secret ?? pr.secret, hours: input.hours ?? pr.hours, updated_at: Date.now() });
    if (!n) throw conflict('Voting started meanwhile.');
    const changed = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.proposal.updated', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { changed, kind, method }, label: g.label, traceId: ctx.traceId ?? null });
    return this.get(ctx.p, pr.id);
  }

  async remove(ctx: Ctx, id: string) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    if (pr.created_by !== ctx.p.userId && !ownsGroup(a.rights)) throw forbidden('Only its author or an owner deletes a draft.', { step: 'author' });
    if (pr.state !== 'draft') throw conflict('Only a draft can be deleted; a proposal put to the vote stays on the record.');
    const n = await this.db('group_proposals').where({ id: pr.id, state: 'draft' }).delete();
    if (!n) throw conflict('Voting started meanwhile.');
    await s.audit.append({ tenantId: pr.tenant_id, action: 'group.proposal.deleted', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: pr.group_id, proposal: pr.id, workspace: pr.workspace_id }, detail: { kind: pr.kind }, label: a.group.label, traceId: ctx.traceId ?? null });
    return { id: pr.id, deleted: true as const };
  }

  /** Who may vote: members whose membership is in effect and who hold more than a guest's rights. */
  private async electorate(g: GroupRow): Promise<string[]> {
    const s = this.s();
    const inEffect = await s.groups.membersWithAccess(g);
    const rights = await s.groups.roles.rightsOfAll(g.id);
    const guest = tierRights('guest');
    return inEffect.filter((u) => {
      const r = rights.get(u);
      return !!r && !covers(guest, r);
    });
  }

  /** Puts a draft to the vote: fixes the electorate and the closing time, and posts it for discussion. */
  async open(ctx: Ctx, id: string, input: { hours?: number | undefined } = {}) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    const g = a.group;
    if (pr.created_by !== ctx.p.userId && !ownsGroup(a.rights)) throw forbidden('Only its author or an owner puts a proposal to the vote.', { step: 'author' });
    if (pr.state !== 'draft') throw conflict(`The proposal is already ${pr.state.replace('_', ' ')}.`);
    if (g.state !== 'active') throw conflict('The group is not open for proposals.');
    const st = await this.settings(g.id);
    const hours = input.hours ?? pr.hours ?? st.defaultHours;
    if (hours < st.minHours || hours > st.maxHours) throw new HttpProblem(422, 'Voting time out of range', `Voting in this group lasts between ${st.minHours} and ${st.maxHours} hours.`, { extensions: { step: 'hours', min: st.minHours, max: st.maxHours } });
    // An action is checked again as the group stands now (a member who left, a role removed).
    const c = await this.content(pr);
    await this.checkAction(g, pr.kind, c.action);
    const voters = await this.electorate(g);
    if (!voters.length) throw new HttpProblem(422, 'Nobody to vote', 'The group has no member who may vote.', { extensions: { step: 'electorate' } });
    const t = Date.now();
    const closes = t + hours * 3_600_000;
    await this.db.transaction(async (trx) => {
      const n = await trx('group_proposals').where({ id: pr.id, state: 'draft' }).update({ state: 'open', opens_at: t, closes_at: closes, hours, electorate: voters.length, updated_at: t });
      if (!n) throw conflict('The proposal was opened meanwhile.');
      for (let i = 0; i < voters.length; i += 200) await trx('group_proposal_electorate').insert(voters.slice(i, i + 200).map((u) => ({ proposal_id: pr.id, tenant_id: pr.tenant_id, user_id: u })));
    });
    const discussion = await this.postDiscussion(ctx, g, pr, c, closes);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.proposal.opened', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { kind: pr.kind, method: pr.method, secret: pr.secret, electorate: voters.length, hours, closesAt: closes, quorum: { kind: pr.quorum_kind, value: pr.quorum_value }, discussion: discussion ? { conversation: discussion.conversationId, message: discussion.messageId } : null }, label: g.label, traceId: ctx.traceId ?? null });
    await s.notifications.notify({ tenantId: g.tenant_id, userIds: voters.filter((u) => u !== ctx.p.userId), kind: 'group.governance', title: `Voting is open on a proposal in ${g.name}`, body: `Voting closes ${new Date(closes).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, route: `groups?id=${g.id}&tab=proposals&proposal=${pr.id}`, label: g.label });
    s.groups.room(g, 'group.proposal.opened', { proposalId: pr.id });
    return this.get(ctx.p, pr.id);
  }

  /** Posts the proposal into the group's linked conversation as its author; null when there is none, or it cannot. */
  private async postDiscussion(ctx: Ctx, g: GroupRow, pr: ProposalRow, c: Content, closes: number): Promise<{ conversationId: string; messageId: string } | null> {
    const s = this.s();
    const link = await s.groups.conversations.ofGroup(g.id);
    if (!link) return null;
    try {
      const m = (await s.messaging.send(ctx, link.conversation_id, { body: `Proposal for discussion: “${c.title}”. Voting is open until ${new Date(closes).toISOString().slice(0, 16).replace('T', ' ')} UTC; vote on the group’s Proposals tab.` })) as { id: string };
      await this.db('group_proposals').where({ id: pr.id }).update({ conversation_id: link.conversation_id, discussion_message_id: m.id });
      return { conversationId: link.conversation_id, messageId: m.id };
    } catch {
      // A held or refused message leaves the proposal without a discussion post; voting goes on.
      await this.db('group_proposals').where({ id: pr.id }).update({ conversation_id: link.conversation_id });
      return null;
    }
  }

  /**
   * Posts a line about the proposal into the conversation, as the group (its decision principal is not a member of
   * the conversation, so the message is written here, sealed as messages are, in the discussion's thread).
   */
  private async postAsGroup(g: Pick<GroupRow, 'id' | 'tenant_id'>, pr: ProposalRow, text: string): Promise<boolean> {
    const s = this.s();
    const link = await s.groups.conversations.ofGroup(g.id);
    if (!link) return false;
    const conv = await s.messaging.row(g.tenant_id, link.conversation_id);
    if (!conv || conv.state !== 'active') return false;
    const fresh = await this.row(pr.tenant_id, pr.id);
    const thread = fresh?.discussion_message_id ?? null;
    const id = ulid();
    const t = Date.now();
    const body = await s.keys.seal(g.tenant_id, text, `dm-message:${id}`);
    await this.db.transaction(async (trx) => {
      await trx('dm_messages').insert({ id, tenant_id: g.tenant_id, conversation_id: conv.id, author_id: g.id, body, reply_to_id: null, thread_id: thread, reply_count: 0, forwarded_from: null, attachments: null, label: conv.label, state: 'sent', edits: 0, edited_at: null, pinned_at: null, pinned_by: null, created_at: t, updated_at: t });
      if (thread) await trx('dm_messages').where({ id: thread }).increment('reply_count', 1);
      await trx('dm_conversations').where({ id: conv.id }).update({ last_message_at: t });
    });
    s.rooms.emit({ tenantId: g.tenant_id, kind: 'conversation', id: conv.id, event: 'conversation.message.created', data: { messageId: id, authorId: g.id, threadId: thread } });
    return true;
  }

  async list(p: Principal, groupId: string, q: { state?: ProposalState | undefined } = {}) {
    const s = this.s();
    const a = await s.groups.require(p, groupId, 'read');
    if (!(await this.installed())) return { available: false as const, proposals: [] };
    await this.closeDueIn(a.group.tenant_id, a.group.id);
    const rows = ((await this.db('group_proposals').where({ tenant_id: a.group.tenant_id, group_id: a.group.id }).modify((qb) => { if (q.state) void qb.andWhere({ state: q.state }); }).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map(proposalFrom)
      .filter((pr) => pr.state !== 'draft' || pr.created_by === p.userId || ownsGroup(a.rights));
    const voted = new Set(rows.length ? ((await this.db('group_vote_participation').whereIn('proposal_id', rows.map((r) => r.id)).andWhere({ user_id: p.userId }).select('proposal_id')) as { proposal_id: string }[]).map((r) => r.proposal_id) : []);
    const electors = new Set(rows.length ? ((await this.db('group_proposal_electorate').whereIn('proposal_id', rows.map((r) => r.id)).andWhere({ user_id: p.userId }).select('proposal_id')) as { proposal_id: string }[]).map((r) => r.proposal_id) : []);
    const names = await this.names(a.group.tenant_id, rows.map((r) => r.created_by));
    const out = [];
    for (const pr of rows) {
      const c = await this.content(pr);
      out.push({ id: pr.id, kind: pr.kind, state: pr.state, title: c.title, method: pr.method, secret: pr.secret, outcome: pr.outcome, opensAt: pr.opens_at, closesAt: pr.closes_at, electorate: pr.electorate, turnout: pr.turnout, needsConfirmation: pr.needs_confirmation && !pr.confirmed_at && pr.state === 'closed', createdBy: pr.created_by, createdByName: names.get(pr.created_by) ?? null, createdAt: pr.created_at, label: this.labelOf(pr, a.group), mine: { eligible: electors.has(pr.id), voted: voted.has(pr.id) } });
    }
    return { available: true as const, proposals: out };
  }

  private labelOf(pr: ProposalRow, g: GroupRow): Label {
    return labelRank(g.label) > labelRank(pr.label) ? g.label : pr.label;
  }

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const want = [...new Set(ids)];
    if (!want.length) return new Map();
    const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', want).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  /** The full view of one proposal for a reader of its group. */
  async get(p: Principal, id: string) {
    let { pr, a } = await this.load(p, id);
    if (pr.state === 'open' && pr.closes_at != null && pr.closes_at <= Date.now()) {
      await this.closeDue(pr);
      ({ pr, a } = await this.load(p, id));
    }
    const g = a.group;
    const c = await this.content(pr);
    const member = !!a.role || a.manager;
    const elector = !!(await this.db('group_proposal_electorate').where({ proposal_id: pr.id, user_id: p.userId }).first('user_id'));
    const voted = !!(await this.db('group_vote_participation').where({ proposal_id: pr.id, user_id: p.userId }).first('user_id'));
    const people = new Set<string>([pr.created_by]);
    if (pr.confirmed_by) people.add(pr.confirmed_by);
    if (typeof c.action.userId === 'string') people.add(c.action.userId);
    let ballots: { userId: string; name: string | null; choice: Choice }[] | undefined;
    let mineChoice: Choice | null = null;
    if (!pr.secret) {
      const rows = (await this.db('group_ballots').where({ proposal_id: pr.id }).whereNotNull('voter_id').orderBy('voted_at')) as { voter_id: string; choice: string }[];
      for (const r of rows) people.add(r.voter_id);
      const nm = await this.names(g.tenant_id, [...people]);
      // Public ballots: who voted for what is visible to the group's members.
      if (member) ballots = rows.map((r) => ({ userId: r.voter_id, name: nm.get(r.voter_id) ?? null, choice: choiceFrom(r.choice) }));
      const own = rows.find((r) => r.voter_id === p.userId);
      if (own) mineChoice = choiceFrom(own.choice);
    }
    const names = await this.names(g.tenant_id, [...people]);
    const result = pr.result ? (JSON.parse(pr.result) as { tally: Tally; commitmentsDigest?: string }) : null;
    const commitments = pr.secret && pr.state !== 'draft' && pr.state !== 'open' ? ((await this.db('group_vote_commitments').where({ proposal_id: pr.id }).orderBy('commitment')) as { commitment: string; choice: string }[]).map((r) => ({ commitment: r.commitment, choice: choiceFrom(r.choice) })) : undefined;
    const st = await this.settings(g.id);
    const open = pr.state === 'open';
    return {
      id: pr.id,
      groupId: g.id,
      groupName: g.name,
      kind: pr.kind,
      state: pr.state,
      title: c.title,
      body: c.body,
      options: c.options,
      action: { ...c.action, ...(typeof c.action.userId === 'string' ? { userName: names.get(c.action.userId) ?? null } : {}) },
      method: pr.method,
      threshold: pr.method === 'supermajority' ? { num: pr.threshold_num, den: pr.threshold_den } : null,
      quorum: { kind: pr.quorum_kind, value: pr.quorum_value },
      secret: pr.secret,
      hours: pr.hours,
      opensAt: pr.opens_at,
      closesAt: pr.closes_at,
      closedAt: pr.closed_at,
      outcome: pr.outcome,
      result: result?.tally ?? null,
      commitmentsDigest: result?.commitmentsDigest ?? null,
      commitments,
      electorate: pr.electorate,
      turnout: pr.turnout,
      ballots,
      needsConfirmation: pr.needs_confirmation,
      confirmedBy: pr.confirmed_by,
      confirmedByName: pr.confirmed_by ? (names.get(pr.confirmed_by) ?? null) : null,
      confirmedAt: pr.confirmed_at,
      carriedAt: pr.carried_at,
      carriedResult: pr.carried_result ? (JSON.parse(pr.carried_result) as Record<string, unknown>) : null,
      failure: pr.failure,
      discussion: pr.conversation_id ? { conversationId: pr.conversation_id, messageId: pr.discussion_message_id } : null,
      label: this.labelOf(pr, g),
      createdBy: pr.created_by,
      createdByName: names.get(pr.created_by) ?? null,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      mine: { eligible: elector, voted, choice: mineChoice },
      can: {
        edit: pr.state === 'draft' && pr.created_by === p.userId,
        open: pr.state === 'draft' && (pr.created_by === p.userId || ownsGroup(a.rights)),
        delete: pr.state === 'draft' && (pr.created_by === p.userId || ownsGroup(a.rights)),
        vote: open && elector,
        confirm: pr.state === 'closed' && pr.outcome === 'passed' && pr.needs_confirmation && !pr.confirmed_at && !pr.carry_claimed_at && ownsGroup(a.rights)
      },
      voting: { minHours: st.minHours, maxHours: st.maxHours, defaultHours: st.defaultHours }
    };
  }

  // ---------- voting ----------

  private commitment(pid: string, ballotId: string, choice: Choice, nonce: string): string {
    return mac(this.s().sysKeys.key('link'), `group-ballot:${pid}:${ballotId}:${choiceText(choice)}:${nonce}`);
  }

  /**
   * Casts or changes the caller's vote. Public: one ballot row naming the voter, replaced on a change. Secret: see
   * `castSecret`. Only the electorate fixed at opening votes, and only while the proposal is open.
   */
  async vote(ctx: Ctx, id: string, input: { choice: unknown; ballotId?: string | undefined; token?: string | undefined }) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    const g = a.group;
    if (pr.state !== 'open') throw conflict(pr.state === 'draft' ? 'Voting has not started.' : 'Voting has closed.');
    if (pr.closes_at != null && pr.closes_at <= Date.now()) {
      await this.closeDue(pr);
      throw conflict('Voting has closed.');
    }
    const elector = await this.db('group_proposal_electorate').where({ proposal_id: pr.id, user_id: ctx.p.userId }).first('user_id');
    if (!elector) throw forbidden('Only the members of the group when voting opened vote on this proposal.', { step: 'electorate' });
    const c = await this.content(pr);
    const check = checkChoice(pr.method, c.options.map((o) => o.id), input.choice);
    if (!check.ok) throw new HttpProblem(422, 'Not a valid vote', check.why, { extensions: { step: 'choice' } });
    if (pr.secret) return this.castSecret(ctx, g, pr, check.choice, input);
    let changed = false;
    await this.db.transaction(async (trx) => {
      await this.lockOpen(trx, pr.id);
      const had = (await trx('group_ballots').where({ proposal_id: pr.id, voter_id: ctx.p.userId }).first('id')) as { id: string } | undefined;
      changed = !!had;
      if (had) await trx('group_ballots').where({ id: had.id }).update({ choice: choiceText(check.choice), voted_at: Date.now() });
      else {
        await trx('group_ballots').insert({ id: randomBytes(16).toString('hex'), tenant_id: pr.tenant_id, proposal_id: pr.id, voter_id: ctx.p.userId, choice: choiceText(check.choice), commitment: null, change_hash: null, voted_at: Date.now() });
        await trx('group_vote_participation').insert({ proposal_id: pr.id, tenant_id: pr.tenant_id, user_id: ctx.p.userId });
      }
    });
    await this.syncTurnout(pr.id);
    await s.audit.append({ tenantId: g.tenant_id, action: changed ? 'group.vote.changed' : 'group.vote.cast', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { secret: false, choice: check.choice }, label: g.label, traceId: ctx.traceId ?? null });
    s.groups.room(g, 'group.proposal.voted', { proposalId: pr.id });
    return { voted: true as const, changed, secret: false as const, choice: check.choice };
  }

  /** Locks the proposal's row for the vote (PostgreSQL and MySQL; SQLite has one writer) and checks it is still open. */
  private async lockOpen(trx: Parameters<Parameters<Services['db']['transaction']>[0]>[0], id: string): Promise<void> {
    const q = trx('group_proposals').where({ id });
    const r = (await (isSqlite(trx) ? q : q.forUpdate()).first('state', 'closes_at')) as { state: string; closes_at: unknown } | undefined;
    if (!r || r.state !== 'open' || Number(r.closes_at) <= Date.now()) throw conflict('Voting has closed.');
  }

  /**
   * A secret ballot. The ballot row has a random id, the choice, the commitment HMAC(link key, proposal, ballot id,
   * choice, nonce) and the digest of a change token; it has no voter and no time. Who voted is a separate row with
   * nothing about how. The voter is given the receipt (ballot id, choice, nonce, commitment) and the change token, and
   * nothing else keeps them: to change the vote they present the ballot id and the token. The audit entry records
   * participation only.
   */
  private async castSecret(ctx: Ctx, g: GroupRow, pr: ProposalRow, choice: Choice, input: { ballotId?: string | undefined; token?: string | undefined }) {
    const s = this.s();
    const voted = !!(await this.db('group_vote_participation').where({ proposal_id: pr.id, user_id: ctx.p.userId }).first('user_id'));
    const nonce = randomBytes(16).toString('hex');
    let ballotId: string;
    let token: string | null = null;
    if (voted) {
      if (!input.ballotId || !input.token) throw new HttpProblem(409, 'Already voted', 'You have voted. To change a secret ballot, give the ballot id and change token from your receipt.', { extensions: { step: 'receipt' } });
      ballotId = input.ballotId;
      const commitment = this.commitment(pr.id, ballotId, choice, nonce);
      await this.db.transaction(async (trx) => {
        await this.lockOpen(trx, pr.id);
        const b = (await trx('group_ballots').where({ id: ballotId, proposal_id: pr.id }).whereNull('voter_id').first('change_hash')) as { change_hash: string | null } | undefined;
        const want = Buffer.from(b?.change_hash ?? '0'.repeat(64), 'hex');
        const got = Buffer.from(sha256(input.token!), 'hex');
        if (!b || want.length !== got.length || !timingSafeEqual(want, got)) throw forbidden('That receipt does not match a ballot on this proposal.', { step: 'receipt' });
        await trx('group_ballots').where({ id: ballotId }).update({ choice: choiceText(choice), commitment });
      });
      await s.audit.append({ tenantId: g.tenant_id, action: 'group.vote.changed', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { secret: true }, label: g.label, traceId: ctx.traceId ?? null });
      s.groups.room(g, 'group.proposal.voted', { proposalId: pr.id });
      return { voted: true as const, changed: true, secret: true as const, receipt: { proposalId: pr.id, ballotId, choice, nonce, commitment, token: input.token } };
    }
    ballotId = randomBytes(16).toString('hex');
    token = randomBytes(24).toString('base64url');
    const commitment = this.commitment(pr.id, ballotId, choice, nonce);
    await this.db.transaction(async (trx) => {
      await this.lockOpen(trx, pr.id);
      await trx('group_vote_participation').insert({ proposal_id: pr.id, tenant_id: pr.tenant_id, user_id: ctx.p.userId });
      await trx('group_ballots').insert({ id: ballotId, tenant_id: pr.tenant_id, proposal_id: pr.id, voter_id: null, choice: choiceText(choice), commitment, change_hash: sha256(token!), voted_at: null });
    });
    await this.syncTurnout(pr.id);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.vote.cast', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { secret: true }, label: g.label, traceId: ctx.traceId ?? null });
    s.groups.room(g, 'group.proposal.voted', { proposalId: pr.id });
    return { voted: true as const, changed: false, secret: true as const, receipt: { proposalId: pr.id, ballotId, choice, nonce, commitment, token } };
  }

  private async syncTurnout(id: string): Promise<void> {
    const r = (await this.db('group_vote_participation').where({ proposal_id: id }).count({ n: '*' })) as { n: number | string }[];
    await this.db('group_proposals').where({ id }).update({ turnout: Number(r[0]?.n ?? 0) });
  }

  /** Checks a receipt against the commitments published at close. */
  async verifyReceipt(p: Principal, id: string, input: { commitment: string; choice: unknown }) {
    const { pr } = await this.load(p, id);
    if (!pr.secret) throw new HttpProblem(422, 'Public ballots', 'This proposal’s ballots are public; there are no receipts.', { extensions: { step: 'secret' } });
    if (pr.state === 'draft' || pr.state === 'open') return { published: false as const, counted: false, detail: 'The commitments are published when voting closes.' };
    const row = (await this.db('group_vote_commitments').where({ proposal_id: pr.id, commitment: input.commitment }).first('choice')) as { choice: string } | undefined;
    const counted = !!row && (Array.isArray(input.choice) || typeof input.choice === 'string') && row.choice === choiceText(input.choice as Choice);
    return { published: true as const, counted, detail: counted ? 'Your commitment is in the published list with your choice, and the tally counts the list.' : row ? 'The commitment is in the list with a different choice.' : 'The commitment is not in the published list.' };
  }

  // ---------- closing ----------

  private async closeDueIn(tenantId: string, groupId?: string): Promise<number> {
    const due = ((await this.db('group_proposals').where({ tenant_id: tenantId, state: 'open' }).andWhere('closes_at', '<=', Date.now()).modify((q) => { if (groupId) void q.andWhere({ group_id: groupId }); }).limit(100)) as Record<string, unknown>[]).map(proposalFrom);
    let closed = 0;
    for (const pr of due) if (await this.closeDue(pr)) closed++;
    return closed;
  }

  /**
   * Closes a proposal whose voting time is over, once (a conditional update claims it), tallies it, publishes the
   * commitments of a secret vote, records the tally and the working in the audit chain, tells the electorate, and
   * carries out a passed decision unless its kind waits for an owner.
   */
  async closeDue(pr: ProposalRow): Promise<boolean> {
    const s = this.s();
    const t = Date.now();
    let claimed = false;
    await this.db.transaction(async (trx) => {
      const q = trx('group_proposals').where({ id: pr.id });
      const r = (await (isSqlite(trx) ? q : q.forUpdate()).first('state', 'closes_at')) as { state: string; closes_at: unknown } | undefined;
      if (!r || r.state !== 'open' || Number(r.closes_at) > t) return;
      claimed = (await trx('group_proposals').where({ id: pr.id, state: 'open' }).update({ state: 'closed', closed_at: t, updated_at: t })) > 0;
    });
    if (!claimed) return false;
    const g = await s.groups.row(pr.tenant_id, pr.group_id);
    const c = await this.content(pr);
    const rows = (await this.db('group_ballots').where({ proposal_id: pr.id }).select('choice', 'commitment')) as { choice: string; commitment: string | null }[];
    const turnout = Number(((await this.db('group_vote_participation').where({ proposal_id: pr.id }).count({ n: '*' })) as { n: number | string }[])[0]?.n ?? 0);
    const result = tally({ method: pr.method, options: c.options.map((o) => o.id), choices: rows.map((r) => choiceFrom(r.choice)), electorate: pr.electorate, quorum: { kind: pr.quorum_kind, value: pr.quorum_value }, threshold: { num: pr.threshold_num, den: pr.threshold_den } });
    let commitmentsDigest: string | undefined;
    if (pr.secret) {
      const list = rows.filter((r) => r.commitment).map((r) => ({ commitment: r.commitment!, choice: r.choice })).sort((x, y) => x.commitment.localeCompare(y.commitment));
      for (let i = 0; i < list.length; i += 200) await this.db('group_vote_commitments').insert(list.slice(i, i + 200).map((x) => ({ proposal_id: pr.id, tenant_id: pr.tenant_id, ...x })));
      commitmentsDigest = sha256(list.map((x) => `${x.commitment} ${x.choice}`).join('\n'));
      // Nothing can change a closed ballot: the change tokens' digests go.
      await this.db('group_ballots').where({ proposal_id: pr.id }).update({ change_hash: null });
    }
    const actionable = ACTIONABLE_KINDS.includes(pr.kind) && result.outcome === 'passed';
    const st = g ? await this.settings(g.id) : DEFAULT_SETTINGS;
    const needsConfirmation = actionable && st.confirmKinds.includes(pr.kind);
    await this.db('group_proposals').where({ id: pr.id }).update({ outcome: result.outcome, result: JSON.stringify({ tally: result, ...(commitmentsDigest ? { commitmentsDigest } : {}) }), turnout, needs_confirmation: needsConfirmation, updated_at: Date.now() });
    const label = g ? this.labelOf(pr, g) : pr.label;
    await s.audit.append({ tenantId: pr.tenant_id, action: 'group.proposal.closed', kind: 'system', actor: SERVICE_ACTOR, target: { group: pr.group_id, proposal: pr.id, workspace: pr.workspace_id }, detail: { kind: pr.kind, method: pr.method, secret: pr.secret, outcome: result.outcome, winner: result.winner ?? null, electorate: pr.electorate, turnout, ballots: result.ballots, quorum: result.quorum, counts: result.counts, ...(result.threshold ? { threshold: result.threshold } : {}), ...(result.rounds ? { rounds: result.rounds } : {}), explanation: result.explanation, ...(commitmentsDigest ? { commitments: rows.length, commitmentsDigest } : {}), needsConfirmation }, label });
    if (!g) return true;
    const words = result.outcome === 'passed' ? (result.winner ? `chosen: ${c.options.find((o) => o.id === result.winner)?.label ?? result.winner}` : 'passed') : result.outcome === 'no_quorum' ? 'not decided, without a quorum' : 'rejected';
    await this.postAsGroup(g, pr, `The vote on “${c.title}” closed: ${words}. ${result.explanation}`).catch(() => false);
    const electors = ((await this.db('group_proposal_electorate').where({ proposal_id: pr.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id);
    const told = new Set(await s.groups.membersWithAccess(g));
    await s.notifications.notify({ tenantId: g.tenant_id, userIds: electors.filter((u) => told.has(u)), kind: 'group.governance', title: `A vote in ${g.name} closed: ${result.outcome === 'passed' ? 'passed' : result.outcome === 'no_quorum' ? 'no quorum' : 'rejected'}`, route: `groups?id=${g.id}&tab=proposals&proposal=${pr.id}`, label: g.label });
    s.groups.room(g, 'group.proposal.closed', { proposalId: pr.id, outcome: result.outcome });
    if (needsConfirmation) {
      const owners = (await s.groups.membersWithAccess(g, 'delete'));
      await s.audit.append({ tenantId: pr.tenant_id, action: 'group.decision.awaiting', kind: 'system', actor: SERVICE_ACTOR, target: { group: g.id, proposal: pr.id, workspace: g.workspace_id }, detail: { kind: pr.kind, owners: owners.length }, label });
      await s.notifications.notify({ tenantId: g.tenant_id, userIds: owners, kind: 'group.governance', title: `A decision in ${g.name} waits for an owner’s confirmation`, route: `groups?id=${g.id}&tab=proposals&proposal=${pr.id}`, label: g.label });
    } else if (actionable) await this.carryOut(pr.tenant_id, pr.id, null);
    return true;
  }

  // ---------- carrying out ----------

  /** An owner confirms a passed decision that waits for them; it is carried out at once. */
  async confirm(ctx: Ctx, id: string) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    if (!ownsGroup(a.rights)) throw forbidden('Only an owner of the group confirms a decision.', { step: 'owner' });
    if (pr.state !== 'closed' || pr.outcome !== 'passed' || !pr.needs_confirmation) throw conflict('This proposal does not wait for confirmation.');
    const t = Date.now();
    const n = await this.db('group_proposals').where({ id: pr.id, state: 'closed' }).whereNull('confirmed_at').whereNull('carry_claimed_at').update({ confirmed_by: ctx.p.userId, confirmed_at: t, updated_at: t });
    if (!n) throw conflict('The decision was confirmed or declined meanwhile.');
    await s.audit.append({ tenantId: pr.tenant_id, action: 'group.decision.confirmed', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: pr.group_id, proposal: pr.id, workspace: pr.workspace_id }, detail: { kind: pr.kind }, label: a.group.label, traceId: ctx.traceId ?? null });
    await this.carryOut(pr.tenant_id, pr.id, ctx.traceId ?? null);
    return this.get(ctx.p, pr.id);
  }

  /** An owner declines a decision that waits for them: it is not carried out (failed, with the reason). */
  async decline(ctx: Ctx, id: string, reason?: string | null) {
    const s = this.s();
    const { pr, a } = await this.load(ctx.p, id);
    if (!ownsGroup(a.rights)) throw forbidden('Only an owner of the group declines a decision.', { step: 'owner' });
    if (pr.state !== 'closed' || pr.outcome !== 'passed' || !pr.needs_confirmation) throw conflict('This proposal does not wait for confirmation.');
    const t = Date.now();
    const why = `Declined by an owner${reason?.trim() ? `: ${reason.trim().slice(0, 500)}` : '.'}`;
    const n = await this.db('group_proposals').where({ id: pr.id, state: 'closed' }).whereNull('confirmed_at').whereNull('carry_claimed_at').update({ state: 'failed', confirmed_by: ctx.p.userId, carry_claimed_at: t, failure: why, updated_at: t });
    if (!n) throw conflict('The decision was confirmed or declined meanwhile.');
    await s.audit.append({ tenantId: pr.tenant_id, action: 'group.decision.declined', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: pr.group_id, proposal: pr.id, workspace: pr.workspace_id }, detail: { kind: pr.kind, reason: !!reason?.trim() }, label: a.group.label, traceId: ctx.traceId ?? null });
    const c = await this.content(pr);
    await this.postAsGroup(a.group, pr, `The decision “${c.title}” was not carried out. ${why}`).catch(() => false);
    return this.get(ctx.p, pr.id);
  }

  /**
   * Carries out a passed decision, at most once: one conditional update claims it, then the action runs through the
   * group's own services as the group (an owner's standing in this group only). The result or the failure is kept on
   * the proposal, audited and posted to the conversation.
   */
  async carryOut(tenantId: string, id: string, traceId: string | null): Promise<'carried_out' | 'failed' | 'skipped'> {
    const s = this.s();
    const t = Date.now();
    const claimed = await this.db('group_proposals').where({ tenant_id: tenantId, id, state: 'closed', outcome: 'passed' }).whereNull('carry_claimed_at').andWhere((q) => { void q.where({ needs_confirmation: false }).orWhereNotNull('confirmed_at'); }).whereIn('kind', [...ACTIONABLE_KINDS]).update({ carry_claimed_at: t, updated_at: t });
    if (!claimed) return 'skipped';
    const pr = (await this.row(tenantId, id))!;
    const g = await s.groups.row(tenantId, pr.group_id);
    const c = await this.content(pr);
    let outcome: 'carried_out' | 'failed';
    let summary: Record<string, unknown> | null = null;
    let failure: string | null = null;
    if (!g || g.state === 'deleted') {
      outcome = 'failed';
      failure = 'The group no longer exists.';
    } else {
      const ctx: Ctx = { p: groupPrincipal(g), ip: null, traceId };
      try {
        summary = await this.apply(ctx, g, pr, c.action);
        outcome = 'carried_out';
      } catch (err) {
        outcome = 'failed';
        failure = err instanceof HttpProblem ? `${err.title}: ${err.detail ?? ''}`.trim() : 'The decision could not be carried out (an internal error; see the server log).';
        if (!(err instanceof HttpProblem)) s.log.warn({ err: (err as Error).message, proposal: id }, 'group decision failed');
      }
    }
    await this.db('group_proposals').where({ id }).update({ state: outcome, carried_at: Date.now(), carried_result: summary ? JSON.stringify(summary) : null, failure, updated_at: Date.now() });
    const label = g ? this.labelOf(pr, g) : pr.label;
    await s.audit.append({ tenantId, action: outcome === 'carried_out' ? 'group.decision.applied' : 'group.decision.failed', kind: 'system', actor: g ? { ...actorFrom(groupPrincipal(g)), service: 'groups.governance' } : SERVICE_ACTOR, target: { group: pr.group_id, proposal: id, workspace: pr.workspace_id }, detail: { kind: pr.kind, ...(summary ? { result: summary } : {}), ...(failure ? { failure } : {}), confirmedBy: pr.confirmed_by }, label, traceId });
    if (g) {
      await this.postAsGroup(g, pr, outcome === 'carried_out' ? `The decision “${c.title}” was carried out.` : `The decision “${c.title}” could not be carried out. ${failure ?? ''}`.trim()).catch(() => false);
      await s.notifications.notify({ tenantId, userIds: [pr.created_by, ...(await s.groups.membersWithAccess(g, 'delete'))].filter((u, i, all) => all.indexOf(u) === i), kind: 'group.governance', title: outcome === 'carried_out' ? `A decision in ${g.name} was carried out` : `A decision in ${g.name} could not be carried out`, route: `groups?id=${g.id}&tab=proposals&proposal=${id}`, label: g.label });
      s.groups.room(g, 'group.proposal.carried', { proposalId: id, state: outcome });
    }
    return outcome;
  }

  /** The decision's action through the group's normal services. */
  private async apply(ctx: Ctx, g: GroupRow, pr: ProposalRow, action: Action): Promise<Record<string, unknown>> {
    const s = this.s();
    switch (pr.kind) {
      case 'setting': {
        const patch = settingPatch.parse(action.patch);
        await s.groups.update(ctx, g.id, patch);
        return { changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) };
      }
      case 'member': {
        const userId = String(action.userId);
        if (action.op === 'remove') {
          await s.groups.removeMember(ctx, g.id, userId);
          return { removed: userId };
        }
        // Owners do not add people directly: they accept a request to join, or invite. So does the group.
        const pending = (await this.db('group_requests').where({ group_id: g.id, user_id: userId, state: 'pending', kind: 'request' }).andWhere('expires_at', '>', Date.now()).first('id')) as { id: string } | undefined;
        if (pending) {
          await s.groups.decide(ctx, pending.id, 'accept');
          return { joined: userId, request: pending.id };
        }
        const inv = await s.groups.invite(ctx, g.id, userId, 'member');
        return { invited: userId, request: inv.id };
      }
      case 'role': {
        const out = await s.groups.setRole(ctx, g.id, String(action.userId), (action.role as GroupRole | undefined) ?? 'member', (action.customRoleId as string | null | undefined) ?? null);
        return { userId: out.userId, role: out.role, customRole: out.customRole?.id ?? null };
      }
      case 'rules': {
        const out = await this.setRules(ctx, g.id, String(action.rules ?? ''));
        return { rules: out.rules ? 'changed' : 'cleared' };
      }
      case 'spend': {
        const out = await this.budget.record(ctx, g.id, { amountMinor: -Math.abs(Number(action.amountMinor)), memo: (action.memo as string | undefined) ?? null, proposalId: pr.id });
        return { entry: out.id, amountMinor: out.amountMinor, currency: out.currency, balanceAfter: out.balanceAfter };
      }
      default:
        return {};
    }
  }

  // ---------- the tick ----------

  /** Closes what is due and sends one reminder before close to the electorate who have not voted yet. */
  async tick(tenantId: string): Promise<{ closed: number; reminded: number }> {
    if (!(await this.installed())) return { closed: 0, reminded: 0 };
    const s = this.s();
    const closed = await this.closeDueIn(tenantId);
    const now = Date.now();
    const soon = ((await this.db('group_proposals').where({ tenant_id: tenantId, state: 'open' }).whereNull('reminded_at').andWhere('closes_at', '>', now).andWhere('closes_at', '<=', now + REMIND_MAX_MS).limit(100)) as Record<string, unknown>[]).map(proposalFrom);
    let reminded = 0;
    for (const pr of soon) {
      const span = (pr.closes_at ?? 0) - (pr.opens_at ?? 0);
      if ((pr.closes_at ?? 0) - now > Math.min(REMIND_MAX_MS, span / 4)) continue;
      const n = await this.db('group_proposals').where({ id: pr.id }).whereNull('reminded_at').update({ reminded_at: now });
      if (!n) continue;
      const g = await s.groups.row(tenantId, pr.group_id);
      if (!g) continue;
      const voted = new Set(((await this.db('group_vote_participation').where({ proposal_id: pr.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
      const inEffect = new Set(await s.groups.membersWithAccess(g));
      const to = ((await this.db('group_proposal_electorate').where({ proposal_id: pr.id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id).filter((u) => !voted.has(u) && inEffect.has(u));
      if (to.length) await s.notifications.notify({ tenantId, userIds: to, kind: 'group.governance', title: `Voting on a proposal in ${g.name} closes soon`, body: `Voting closes ${new Date(pr.closes_at!).toISOString().slice(0, 16).replace('T', ' ')} UTC.`, route: `groups?id=${g.id}&tab=proposals&proposal=${pr.id}`, label: g.label });
      reminded++;
    }
    return { closed, reminded };
  }

  registerJobs(): void {
    this.s().jobs.register(GOVERNANCE_TICK_JOB, async (p, ctx) => this.tick(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  schedule(scheduler: Scheduler, targets: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    scheduler.every(GOVERNANCE_TICK_JOB, 60_000, targets);
  }
}
