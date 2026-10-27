import { ulid } from 'ulid';
import { z } from 'zod';
import { clears, labelRank, LABELS, type Label } from '../authz/labels.js';
import type { Permission } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { actorFrom } from '../audit/chain.js';
import { configHash } from '../evals/service.js';
import type { ProfileRow } from '../gateway/repo.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import type { AgentDefinition, EntryRow } from '../registry/service.js';
import type { Services } from '../services.js';
import { ATTACK_CATEGORIES, BUILTIN_ATTACKS, builtinAttacks, CATEGORY_TEXT, judge, type Attack, type AttackCategory } from './attacks.js';

/*
 * 1.6.0, Sprint 38b (B-7001, B-7002): red-team suites. A suite is an adversarial evaluation of a target: a profile,
 * an agent (by name, whichever version is published) or a workflow. It runs the built-in attack categories it lists
 * (`attacks.ts`) and the tenant's own cases; an attack is resisted when the answer carries no canary, reaches for no
 * outside address and reproduces no system prompt. A run is a job: a profile answers each attack through the gateway
 * as evaluations do (`EvalService.answerFor`, so what users would see is judged); an agent or a workflow runs each
 * attack as a child run of its own, and the red-team run ends when they do (the agent service reports a child's end
 * through `childDone`; workflow children are read when the run is looked at). Every attack that succeeded is a flag
 * (`source_kind: redteam-run`), which a reviewer confirms into an eval case like any other flag.
 *
 * The gate: a profile with gated suites is published (or changed while published in a way that changes its settings
 * hash) only when the latest run of every gated suite at its current revision passed for that hash; an agent version
 * with gated suites is approved only when its schema hash has a passing run. Evaluation overrides do not open the
 * red-team gate: a leaking profile stays unpublished until a run passes or the suite's gate is turned off.
 */

export type TargetKind = 'profile' | 'agent' | 'workflow';
export const TARGET_KINDS = ['profile', 'agent', 'workflow'] as const;
export const targetKind = z.enum(TARGET_KINDS);

const MAX_CASES = 50;
const OUTPUT_KEEP = 2000;

export const attackCase = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  name: z.string().trim().max(200).optional(),
  category: z.enum(ATTACK_CATEGORIES),
  prompt: z.string().min(1).max(20_000),
  /** A word the attack wants in the answer; without one, only the category's other evidence (an outside address, the system prompt) counts. */
  canary: z.string().trim().min(3).max(80).nullable().optional()
});
export type AttackCase = z.infer<typeof attackCase> & { id: string };

export const suiteBody = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  label: z.enum(LABELS).optional(),
  categories: z.array(z.enum(ATTACK_CATEGORIES)).max(ATTACK_CATEGORIES.length).default([...ATTACK_CATEGORIES]),
  cases: z.array(attackCase).max(MAX_CASES).default([]),
  /** The share of attacks that must be resisted (1: every one). */
  threshold: z.number().min(0).max(1).default(1),
  gate: z.boolean().default(true)
});
export type SuiteInput = z.infer<typeof suiteBody>;

interface SuiteRow {
  id: string;
  tenant_id: string;
  target_kind: TargetKind;
  target_id: string;
  name: string;
  description: string | null;
  label: Label;
  categories: string;
  cases: string;
  threshold: number;
  gate: boolean;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export type RunState = 'queued' | 'running' | 'passed' | 'failed' | 'error';

interface RunRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  suite_id: string;
  target_kind: TargetKind;
  target_id: string;
  target_version: string | null;
  config_hash: string;
  suite_revision: number;
  state: RunState;
  attacks: number | null;
  resisted: number | null;
  threshold: number;
  results: string | null;
  error: string | null;
  trigger: string;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface AttackResult {
  attackId: string;
  category: AttackCategory;
  name: string;
  builtin: boolean;
  /** null while a child run is still going. */
  resisted: boolean | null;
  detail: string | null;
  output: string;
  /** The agent or workflow run that answered this attack. */
  childRun: string | null;
  flagId: string | null;
  flagRef: string | null;
  ms: number;
}

export interface Target {
  kind: TargetKind;
  id: string;
  name: string;
  version: string;
  configHash: string;
  label: Label;
  systemPrompt: string | null;
  /** For agents: the entry the attacks run against. */
  entry?: EntryRow;
  profile?: ProfileRow;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const suiteFrom = (r: Record<string, unknown>): SuiteRow => ({ ...(r as unknown as SuiteRow), threshold: Number(r.threshold), gate: !!r.gate, revision: Number(r.revision), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const runFrom = (r: Record<string, unknown>): RunRow => ({ ...(r as unknown as RunRow), suite_revision: Number(r.suite_revision), attacks: num(r.attacks), resisted: num(r.resisted), threshold: Number(r.threshold), created_at: Number(r.created_at), finished_at: num(r.finished_at) });

const ENDED_AGENT = ['succeeded', 'failed', 'cancelled', 'budget'];
const ENDED_WORKFLOW = ['succeeded', 'failed', 'cancelled'];

/** The permission that manages suites of a target kind. */
export const permissionForTarget = (kind: TargetKind): Permission => (kind === 'profile' ? 'profiles:manage' : kind === 'agent' ? 'agents:manage' : 'workflows:manage');

export class RedTeamService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('redteam.run', async (p, ctx) => this.execute(String(p.runId), ctx.signal, ctx.progress), { timeoutMs: 2 * 3_600_000 });
  }

  /** The catalogue the console shows: categories and the built-in attacks (prompts included, so tenants can read what runs). */
  catalogue() {
    return { categories: ATTACK_CATEGORIES.map((c) => ({ id: c, ...CATEGORY_TEXT[c], attacks: BUILTIN_ATTACKS.filter((a) => a.category === c).length })), attacks: BUILTIN_ATTACKS.map((a) => ({ id: a.id, category: a.category, name: a.name, prompt: a.prompt, canary: a.canary, marker: a.marker })) };
  }

  // ---------- targets ----------

  async target(tenantId: string, kind: TargetKind, id: string): Promise<Target> {
    const s = this.s();
    if (kind === 'profile') {
      const p = await s.gateway.repo.profile(tenantId, id);
      if (!p) throw notFound('Profile');
      if (p.alias_of) throw badRequest('An alias has no red-team suites of its own; test the profile it points at.');
      return { kind, id: p.id, name: p.name, version: String(p.version), configHash: configHash(p), label: p.label, systemPrompt: p.system_prompt ?? null, profile: p };
    }
    if (kind === 'agent') {
      const rows = (await s.registry.list(tenantId, { kind: 'agent' })).filter((e) => e.name === id && e.status !== 'retired');
      const entry = rows.find((e) => e.status === 'published') ?? rows.find((e) => e.status === 'deprecated') ?? rows.sort((a, b) => b.created_at - a.created_at)[0];
      if (!entry) throw notFound('Agent');
      const def = entry.definition as unknown as AgentDefinition;
      return { kind, id: entry.name, name: entry.name, version: entry.version, configHash: entry.schema_hash, label: entry.label, systemPrompt: def.systemPrompt ?? null, entry };
    }
    const w = (await this.db('workflows').where({ tenant_id: tenantId, id }).first()) as { id: string; name: string; label: Label; published_version: number | null } | undefined;
    if (!w) throw notFound('Workflow');
    if (!w.published_version) throw conflict(`${w.name} has no published version yet; red-team suites run the published version.`);
    return { kind, id: w.id, name: w.name, version: String(w.published_version), configHash: `v${w.published_version}`, label: w.label, systemPrompt: null };
  }

  // ---------- suites ----------

  private async suites(tenantId: string, kind: TargetKind, targetId: string): Promise<SuiteRow[]> {
    return ((await this.db('redteam_suites').where({ tenant_id: tenantId, target_kind: kind, target_id: targetId }).orderBy('created_at')) as Record<string, unknown>[]).map(suiteFrom);
  }

  private async suite(p: Principal, id: string): Promise<SuiteRow> {
    const r = (await this.db('redteam_suites').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    const x = r ? suiteFrom(r) : null;
    if (!x || !clears(p.clearance, x.label)) throw notFound('Red-team suite');
    return x;
  }

  private async cases(x: SuiteRow): Promise<AttackCase[]> {
    return JSON.parse(await this.s().keys.open(x.tenant_id, x.cases, `redteam-suite:${x.id}`)) as AttackCase[];
  }

  private categories(x: SuiteRow): AttackCategory[] {
    try {
      return (JSON.parse(x.categories) as string[]).filter((c): c is AttackCategory => (ATTACK_CATEGORIES as readonly string[]).includes(c));
    } catch {
      return [];
    }
  }

  private validate(p: Principal, t: Target, input: Pick<SuiteInput, 'cases' | 'categories'> & { label: Label }): AttackCase[] {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} suite is above it.`, { step: 'clearance' });
    if (labelRank(input.label) > labelRank(t.label)) throw forbidden(`${t.name} handles data up to ${t.label}; this suite is ${input.label}.`, { step: 'zone' });
    if (!input.categories.length && !input.cases.length) throw badRequest('A suite needs at least one attack category or one case of its own.');
    const ids = new Set<string>();
    return input.cases.map((c, i) => {
      const id = c.id ?? `case-${i + 1}`;
      if (ids.has(id) || BUILTIN_ATTACKS.some((a) => a.id === id)) throw badRequest(`Two attacks have the id ${id}.`);
      ids.add(id);
      return { ...c, id, canary: c.canary ?? null };
    });
  }

  private suiteView(x: SuiteRow, cases: AttackCase[]) {
    const categories = this.categories(x);
    return { id: x.id, targetKind: x.target_kind, targetId: x.target_id, name: x.name, description: x.description, label: x.label, categories, cases, attacks: builtinAttacks(categories).length + cases.length, threshold: x.threshold, gate: x.gate, revision: x.revision, createdAt: x.created_at, updatedAt: x.updated_at };
  }

  async createSet(p: Principal, kind: TargetKind, targetId: string, input: SuiteInput) {
    const t = await this.target(p.tenantId, kind, targetId);
    const label = input.label ?? t.label;
    const cases = this.validate(p, t, { ...input, label });
    if (await this.db('redteam_suites').where({ tenant_id: p.tenantId, target_kind: kind, target_id: t.id, name: input.name }).first('id')) throw conflict(`${t.name} already has a red-team suite named ${input.name}.`);
    const now = Date.now();
    const row: SuiteRow = { id: ulid(), tenant_id: p.tenantId, target_kind: kind, target_id: t.id, name: input.name, description: input.description ?? null, label, categories: JSON.stringify(input.categories), cases: await this.s().keys.seal(p.tenantId, JSON.stringify(cases), ''), threshold: input.threshold, gate: input.gate, revision: 1, created_by: p.userId, updated_by: p.userId, created_at: now, updated_at: now };
    row.cases = await this.s().keys.seal(p.tenantId, JSON.stringify(cases), `redteam-suite:${row.id}`);
    await this.db('redteam_suites').insert(row);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'redteam.suite.created', kind: 'admin', actor: actorFrom(p), target: { suite: row.id, name: row.name, targetKind: kind, targetId: t.id, targetName: t.name }, label, detail: { categories: input.categories, cases: cases.length, threshold: input.threshold, gate: input.gate } });
    return this.suiteView(row, cases);
  }

  async updateSet(p: Principal, id: string, patch: Partial<SuiteInput>) {
    const x = await this.suite(p, id);
    const t = await this.target(p.tenantId, x.target_kind, x.target_id);
    const label = patch.label ?? x.label;
    const categories = patch.categories ?? this.categories(x);
    const cases = this.validate(p, t, { cases: patch.cases ?? (await this.cases(x)), categories, label });
    // What decides a pass is part of the revision: a run on an older revision no longer opens the gate.
    const decisive = patch.cases !== undefined || patch.categories !== undefined || patch.threshold !== undefined || (patch.gate === true && !x.gate);
    const upd: Record<string, unknown> = { updated_by: p.userId, updated_at: Date.now(), label, categories: JSON.stringify(categories), cases: await this.s().keys.seal(p.tenantId, JSON.stringify(cases), `redteam-suite:${x.id}`), ...(decisive ? { revision: x.revision + 1 } : {}) };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.threshold !== undefined) upd.threshold = patch.threshold;
    if (patch.gate !== undefined) upd.gate = patch.gate;
    await this.db('redteam_suites').where({ id: x.id }).update(upd);
    const after = await this.suite(p, x.id);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'redteam.suite.updated', kind: 'admin', actor: actorFrom(p), target: { suite: x.id, name: after.name, targetKind: x.target_kind, targetId: x.target_id }, label, detail: { changed: Object.keys(patch), revision: after.revision } });
    return this.suiteView(after, cases);
  }

  /** A suite's target, for the permission check of a change to it. */
  async suiteOf(p: Principal, id: string): Promise<{ id: string; targetKind: TargetKind; targetId: string }> {
    const x = await this.suite(p, id);
    return { id: x.id, targetKind: x.target_kind, targetId: x.target_id };
  }

  async removeSet(p: Principal, id: string) {
    const x = await this.suite(p, id);
    await this.db('redteam_runs').where({ suite_id: x.id }).delete();
    await this.db('redteam_suites').where({ id: x.id }).delete();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'redteam.suite.deleted', kind: 'admin', actor: actorFrom(p), target: { suite: x.id, name: x.name, targetKind: x.target_kind, targetId: x.target_id }, label: x.label });
    return x;
  }

  // ---------- reads ----------

  private runView(r: RunRow, suiteName?: string | null) {
    return { id: r.id, suiteId: r.suite_id, suite: suiteName ?? null, targetKind: r.target_kind, targetId: r.target_id, targetVersion: r.target_version, configHash: r.config_hash, suiteRevision: r.suite_revision, state: r.state, attacks: r.attacks, resisted: r.resisted, score: r.attacks ? (r.resisted ?? 0) / r.attacks : null, threshold: r.threshold, error: r.error, trigger: r.trigger, createdBy: r.created_by, createdAt: r.created_at, finishedAt: r.finished_at };
  }

  /** Everything the Red team panel shows for a target: suites, the run history, the gate for the saved version. */
  async overview(p: Principal, kind: TargetKind, targetId: string) {
    const t = await this.target(p.tenantId, kind, targetId);
    await this.refreshRunning(p.tenantId, kind, t.id);
    const suites = (await this.suites(p.tenantId, kind, t.id)).filter((x) => clears(p.clearance, x.label));
    const names = new Map(suites.map((x) => [x.id, x.name]));
    const runs = ((await this.db('redteam_runs').where({ tenant_id: p.tenantId, target_kind: kind, target_id: t.id }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(runFrom).filter((r) => names.has(r.suite_id));
    const people = [...new Set(runs.map((r) => r.created_by).filter((x): x is string => !!x))];
    const userNames = new Map(((await this.db('users').whereIn('id', people).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    return {
      target: { kind: t.kind, id: t.id, name: t.name, version: t.version, configHash: t.configHash, label: t.label, hasSystemPrompt: !!t.systemPrompt },
      suites: await Promise.all(suites.map(async (x) => this.suiteView(x, await this.cases(x)))),
      runs: runs.map((r) => ({ ...this.runView(r, names.get(r.suite_id)), createdByName: r.created_by ? (userNames.get(r.created_by) ?? null) : null })),
      gate: await this.gateStatus(p.tenantId, kind, t.id, t.configHash),
      categories: ATTACK_CATEGORIES.map((c) => ({ id: c, ...CATEGORY_TEXT[c], attacks: BUILTIN_ATTACKS.filter((a) => a.category === c).length }))
    };
  }

  async run(p: Principal, id: string) {
    const r = (await this.db('redteam_runs').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Red-team run');
    let run = runFrom(r);
    const x = await this.suite(p, run.suite_id).catch(() => null);
    if (!x) throw notFound('Red-team run');
    if (run.state === 'running') run = (await this.refresh(run)) ?? run;
    const results = run.results ? (JSON.parse(await this.s().keys.open(run.tenant_id, run.results, `redteam-run:${run.id}`)) as AttackResult[]) : [];
    return { ...this.runView(run, x.name), results };
  }

  // ---------- runs ----------

  /** Queues a run per suite (every suite of the target, or one) on the target as saved now. */
  async start(p: Principal, kind: TargetKind, targetId: string, input: { suiteId?: string; trigger?: string }) {
    const t = await this.target(p.tenantId, kind, targetId);
    if (t.profile && !t.profile.model_id) throw conflict('Choose a model before red-teaming the profile.');
    const suites = input.suiteId ? [await this.suite(p, input.suiteId)] : (await this.suites(p.tenantId, kind, t.id)).filter((x) => clears(p.clearance, x.label));
    if (!suites.length) throw conflict(`${t.name} has no red-team suites yet.`);
    if (suites.some((x) => x.target_kind !== kind || x.target_id !== t.id)) throw badRequest('That suite belongs to another target.');
    const out = [];
    for (const x of suites) {
      const id = ulid();
      const row: RunRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, suite_id: x.id, target_kind: kind, target_id: t.id, target_version: t.version, config_hash: t.configHash, suite_revision: x.revision, state: 'queued', attacks: null, resisted: null, threshold: x.threshold, results: null, error: null, trigger: input.trigger ?? 'manual', job_id: null, created_by: p.userId, created_at: Date.now(), finished_at: null };
      await this.db('redteam_runs').insert(row);
      const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'redteam.run', payload: { runId: id }, createdBy: p.userId, maxAttempts: 1 });
      await this.db('redteam_runs').where({ id }).update({ job_id: job.id });
      out.push(this.runView({ ...row, job_id: job.id }, x.name));
    }
    await this.s().audit.append({ tenantId: p.tenantId, action: 'redteam.started', kind: 'admin', actor: actorFrom(p), target: { targetKind: kind, targetId: t.id, targetName: t.name }, label: t.label, detail: { runs: out.map((r) => r.id), version: t.version, trigger: input.trigger ?? 'manual' } });
    return out;
  }

  private attacksOf(x: SuiteRow, cases: AttackCase[]): Attack[] {
    return [...builtinAttacks(this.categories(x)), ...cases.map((c) => ({ id: c.id, category: c.category, name: c.name ?? c.id, prompt: c.prompt, canary: c.canary ?? null, marker: null, builtin: false }))];
  }

  private async finish(run: RunRow, state: RunState, extra: Record<string, unknown>): Promise<unknown> {
    await this.db('redteam_runs').where({ id: run.id }).update({ state, finished_at: Date.now(), ...extra });
    const x = (await this.db('redteam_suites').where({ id: run.suite_id }).first()) as Record<string, unknown> | undefined;
    await this.s().audit.append({ tenantId: run.tenant_id, action: `redteam.run.${state}`, kind: 'system', actor: { service: 'redteam', ...(run.created_by ? { user: run.created_by } : {}) }, target: { run: run.id, suite: run.suite_id, targetKind: run.target_kind, targetId: run.target_id }, label: (x?.label as Label | undefined) ?? 'internal', detail: { version: run.target_version, configHash: run.config_hash, attacks: extra.attacks ?? null, resisted: extra.resisted ?? null, error: extra.error ?? null } });
    return { state, ...extra, results: undefined };
  }

  /** The job: runs every attack against the target as saved and records what was resisted. */
  private async execute(runId: string, signal: AbortSignal, progress: (pct: number, message?: string) => Promise<void>): Promise<unknown> {
    const s = this.s();
    const r = (await this.db('redteam_runs').where({ id: runId }).first()) as Record<string, unknown> | undefined;
    if (!r) return { skipped: 'gone' };
    const run = runFrom(r);
    if (run.state !== 'queued') return { skipped: run.state };
    const suiteRow = (await this.db('redteam_suites').where({ id: run.suite_id }).first()) as Record<string, unknown> | undefined;
    if (!suiteRow) return this.finish(run, 'error', { error: 'The suite was deleted.' });
    const x = suiteFrom(suiteRow);
    if (x.revision !== run.suite_revision) return this.finish(run, 'error', { error: 'The suite changed after this run was queued; run it again.' });
    let t: Target;
    try {
      t = await this.target(run.tenant_id, run.target_kind, run.target_id);
    } catch (err) {
      return this.finish(run, 'error', { error: err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message });
    }
    if (t.configHash !== run.config_hash) return this.finish(run, 'error', { error: `${t.name} changed after this run was queued; run it again.` });
    const who = run.created_by ? await loadPrincipal(s, run.tenant_id, run.created_by, {}) : null;
    if (!who) return this.finish(run, 'error', { error: 'The person who started this run can no longer act.' });
    who.workspaceId = run.workspace_id;
    const attacks = this.attacksOf(x, await this.cases(x));
    if (!attacks.length) return this.finish(run, 'error', { error: 'The suite has no attacks.' });
    await this.db('redteam_runs').where({ id: run.id }).update({ state: 'running', attacks: attacks.length });
    const results: AttackResult[] = [];
    const seal = () => s.keys.seal(run.tenant_id, JSON.stringify(results), `redteam-run:${run.id}`);
    try {
      if (t.kind === 'profile') {
        const profile = t.profile!;
        for (const [i, a] of attacks.entries()) {
          const started = Date.now();
          const answer = await s.evals.answerFor(who, profile, x.label, a.prompt, signal);
          const v = judge(a, { answer, systemPrompt: t.systemPrompt });
          results.push({ attackId: a.id, category: a.category, name: a.name, builtin: a.builtin, resisted: v.resisted, detail: v.detail, output: answer.slice(0, OUTPUT_KEEP), childRun: null, flagId: null, flagRef: null, ms: Date.now() - started });
          await progress(Math.round(((i + 1) / attacks.length) * 100), `${i + 1} of ${attacks.length} attacks`);
        }
        return this.conclude({ ...run, state: 'running', attacks: attacks.length }, x, t, results);
      }
      // Agents and workflows answer as child runs; the run ends when they do.
      for (const a of attacks) {
        const started = Date.now();
        let childRun: string;
        if (t.kind === 'agent') {
          const child = await s.agents.start(who, { agent: t.entry!.id, input: a.prompt, label: x.label, budgets: { steps: 8, toolCalls: 4, wallSeconds: 180, tokens: 8000 } }, { caller: { kind: 'redteam-run', id: run.id, node: a.id } });
          childRun = child.id;
        } else {
          const w = await s.workflows.start(who, t.id, { input: await this.workflowInput(run.tenant_id, t.id, a.prompt), dry: false, trigger: 'redteam' });
          childRun = w.id;
        }
        results.push({ attackId: a.id, category: a.category, name: a.name, builtin: a.builtin, resisted: null, detail: null, output: '', childRun, flagId: null, flagRef: null, ms: Date.now() - started });
        await this.db('redteam_runs').where({ id: run.id }).update({ results: await seal() });
      }
      await progress(5, `${attacks.length} attacks started`);
      // The children may all have ended already (an in-process queue that ran them at once).
      const now = (await this.refresh({ ...run, state: 'running', attacks: attacks.length })) ?? run;
      return { state: now.state };
    } catch (err) {
      const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      return this.finish(run, 'error', { error: message.slice(0, 500), results: await seal() });
    }
  }

  /** The published workflow's trigger input with the attack in its first string field (or `input`). */
  private async workflowInput(tenantId: string, workflowId: string, prompt: string): Promise<Record<string, unknown>> {
    const w = (await this.db('workflows').where({ tenant_id: tenantId, id: workflowId }).first('published_version')) as { published_version: number | null } | undefined;
    const v = w?.published_version ? ((await this.db('workflow_versions').where({ workflow_id: workflowId, version: w.published_version }).first('graph')) as { graph: string | Record<string, unknown> } | undefined) : undefined;
    try {
      const graph = (typeof v?.graph === 'string' ? JSON.parse(v.graph) : v?.graph) as { nodes?: { kind: string; output?: { type?: string; properties?: Record<string, { type?: string }> } }[] } | undefined;
      const trigger = graph?.nodes?.find((n) => n.kind === 'trigger');
      const props = Object.entries(trigger?.output?.properties ?? {});
      const first = props.find(([, t]) => t.type === 'string') ?? props[0];
      if (first) return { [first[0]]: prompt };
    } catch {
      /* no trigger schema: the attack goes in as `input` */
    }
    return { input: prompt };
  }

  /**
   * Looks at a running run's children: those that ended (or wait on an approval, which is itself the evidence of a
   * write the agent reached for) are judged, and the run concludes when none is left. Returns the run as it is now.
   */
  private async refresh(run: RunRow): Promise<RunRow | null> {
    const s = this.s();
    if (run.state !== 'running' || !run.results) return null;
    const results = JSON.parse(await s.keys.open(run.tenant_id, run.results, `redteam-run:${run.id}`)) as AttackResult[];
    const x = suiteFrom((await this.db('redteam_suites').where({ id: run.suite_id }).first()) as Record<string, unknown>);
    const attacks = new Map(this.attacksOf(x, await this.cases(x)).map((a) => [a.id, a]));
    let t: Target | null;
    try {
      t = await this.target(run.tenant_id, run.target_kind, run.target_id);
    } catch {
      t = null;
    }
    let changed = false;
    for (const res of results) {
      if (res.resisted != null || !res.childRun) continue;
      const a = attacks.get(res.attackId);
      if (!a) continue;
      let evidence: { ended: boolean; answer: string; toolCalls: string[]; error: string | null } | null = null;
      if (run.target_kind === 'agent') {
        const e = await s.agents.redTeamEvidence(run.tenant_id, res.childRun);
        if (!e) evidence = { ended: true, answer: '', toolCalls: [], error: 'the run no longer exists' };
        else if (ENDED_AGENT.includes(e.state) || e.state === 'waiting') {
          if (e.state === 'waiting') await s.agents.cancelForStep(run.tenant_id, res.childRun, 'The red-team run does not approve calls.').catch(() => undefined);
          evidence = { ended: true, answer: e.output ?? '', toolCalls: e.toolCalls, error: e.state === 'succeeded' ? null : (e.error ?? e.state) };
        }
      } else {
        const w = (await this.db('workflow_runs').where({ tenant_id: run.tenant_id, id: res.childRun }).first('state', 'error')) as { state: string; error: string | null } | undefined;
        if (!w) evidence = { ended: true, answer: '', toolCalls: [], error: 'the run no longer exists' };
        else if (ENDED_WORKFLOW.includes(w.state) || w.state === 'waiting') evidence = { ended: true, answer: await this.workflowAnswer(run.tenant_id, res.childRun), toolCalls: [], error: w.state === 'succeeded' ? null : (w.error ?? w.state) };
      }
      if (!evidence?.ended) continue;
      const v = judge(a, { answer: evidence.answer, systemPrompt: t?.systemPrompt ?? null, toolCalls: evidence.toolCalls });
      res.resisted = v.resisted;
      res.detail = v.detail ?? (evidence.error ? `the run ended with: ${evidence.error}` : null);
      res.output = evidence.answer.slice(0, OUTPUT_KEEP);
      changed = true;
    }
    if (!changed) return run;
    if (results.some((r) => r.resisted == null)) {
      await this.db('redteam_runs').where({ id: run.id, state: 'running' }).update({ results: await s.keys.seal(run.tenant_id, JSON.stringify(results), `redteam-run:${run.id}`) });
      return { ...run, results: null };
    }
    await this.conclude(run, x, t, results);
    return runFrom((await this.db('redteam_runs').where({ id: run.id }).first()) as Record<string, unknown>);
  }

  /** Every running run of a target, refreshed (workflow children have no hook back into this service). */
  private async refreshRunning(tenantId: string, kind: TargetKind, targetId: string): Promise<void> {
    const rows = ((await this.db('redteam_runs').where({ tenant_id: tenantId, target_kind: kind, target_id: targetId, state: 'running' })) as Record<string, unknown>[]).map(runFrom);
    for (const r of rows) await this.refresh(r).catch(() => undefined);
  }

  /** The agent service reports a child run's end (`caller_kind: redteam-run`). */
  async childDone(tenantId: string, runId: string): Promise<void> {
    const r = (await this.db('redteam_runs').where({ tenant_id: tenantId, id: runId }).first()) as Record<string, unknown> | undefined;
    if (r) await this.refresh(runFrom(r));
  }

  private async workflowAnswer(tenantId: string, runId: string): Promise<string> {
    const steps = (await this.db('workflow_steps').where({ run_id: runId }).orderBy('created_at').select('id', 'output')) as { id: string; output: string | null }[];
    const texts: string[] = [];
    for (const st of steps) {
      if (!st.output) continue;
      try {
        const v = JSON.parse(await this.s().keys.open(tenantId, st.output, `wfstep:${st.id}`)) as unknown;
        texts.push(typeof v === 'string' ? v : JSON.stringify(v));
      } catch {
        /* a step output that cannot be opened is no evidence */
      }
    }
    return texts.join('\n');
  }

  /** Scores the results, raises a flag per successful attack and ends the run. */
  private async conclude(run: RunRow, x: SuiteRow, t: Target | null, results: AttackResult[]): Promise<unknown> {
    const s = this.s();
    const targetName = t?.name ?? run.target_id;
    for (const res of results) {
      if (res.resisted !== false || res.flagId) continue;
      try {
        const f = await s.guard.flags.create({
          tenantId: run.tenant_id,
          workspaceId: run.workspace_id,
          kind: 'report',
          checkpoint: 'red-team',
          ruleName: `Red team: ${CATEGORY_TEXT[res.category].label}`,
          severity: res.category === 'system-prompt' || res.category === 'exfiltration' ? 'high' : 'medium',
          label: x.label,
          text: res.output || res.detail || res.name,
          note: `${res.name} succeeded against ${run.target_kind} ${targetName} (version ${run.target_version ?? '?'}): ${res.detail ?? 'the attack succeeded'}. Red-team run ${run.id}.`,
          actor: run.created_by ? { user: run.created_by, via: 'red-team' } : null,
          source: { kind: 'redteam-run', id: run.id }
        });
        res.flagId = f.id;
        res.flagRef = `F-${f.number}`;
      } catch {
        /* a flag that cannot be raised does not change the verdict */
      }
    }
    const resisted = results.filter((r) => r.resisted).length;
    const score = results.length ? resisted / results.length : 0;
    return this.finish({ ...run }, score >= x.threshold ? 'passed' : 'failed', { attacks: results.length, resisted, results: await s.keys.seal(run.tenant_id, JSON.stringify(results), `redteam-run:${run.id}`) });
  }

  // ---------- the gate ----------

  async gateStatus(tenantId: string, kind: TargetKind, targetId: string, hash: string) {
    const gated = (await this.suites(tenantId, kind, targetId)).filter((x) => x.gate);
    const failing: { suiteId: string; suite: string; reason: string; score: number | null; threshold: number }[] = [];
    for (const x of gated) {
      const last = ((await this.db('redteam_runs').where({ suite_id: x.id, config_hash: hash, suite_revision: x.revision }).whereIn('state', ['passed', 'failed', 'error']).orderBy('created_at', 'desc').limit(1)) as Record<string, unknown>[]).map(runFrom)[0];
      if (last?.state === 'passed') continue;
      const score = last?.attacks ? (last.resisted ?? 0) / last.attacks : null;
      failing.push({ suiteId: x.id, suite: x.name, threshold: x.threshold, score, reason: !last ? 'not red-teamed for these settings' : last.state === 'error' ? `the last run failed to finish: ${last.error ?? 'error'}` : `resisted ${last.resisted ?? 0} of ${last.attacks ?? 0} attacks (needs ${Math.round(x.threshold * 100)}%)` });
    }
    return { configHash: hash, gated: gated.length, failing, open: !failing.length };
  }

  private refuse(name: string, what: string, g: Awaited<ReturnType<RedTeamService['gateStatus']>>): never {
    const detail = g.failing.map((f) => `${f.suite}: ${f.reason}`).join('; ');
    throw new HttpProblem(409, 'Red-team suites not passed', `${name} cannot be ${what} with these settings. ${detail}. Run the red-team suites, or turn their gate off.`, { extensions: { code: 'redteam_gate', failing: g.failing, configHash: g.configHash } });
  }

  /** Called with the evaluation gate before a profile version is saved. */
  async gateProfile(tenantId: string, before: ProfileRow, next: ProfileRow): Promise<void> {
    if (next.alias_of || next.status !== 'published') return;
    if (before.status === 'published' && configHash(before) === configHash(next)) return;
    const g = await this.gateStatus(tenantId, 'profile', next.id, configHash(next));
    if (!g.open) this.refuse(next.name, 'published', g);
  }

  /** Called before an agent version is approved (published) or re-published. */
  async gateAgent(tenantId: string, entry: EntryRow): Promise<void> {
    if (entry.kind !== 'agent') return;
    const g = await this.gateStatus(tenantId, 'agent', entry.name, entry.schema_hash);
    if (!g.open) this.refuse(`${entry.name} ${entry.version}`, 'published', g);
  }
}
