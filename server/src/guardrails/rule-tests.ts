import { ulid } from 'ulid';
import { z } from 'zod';
import { json, type Db } from '../db/knex.js';
import { clears, isLabel, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { parseCsv } from '../identity/user-import.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { GuardrailEngine, RuleResult } from './engine.js';
import { diffRules, type Rule } from './rules.js';
import type { RuleSetRow, RuleSetService, VersionRow } from './sets.js';
import { CHECKPOINTS, GUARD_ACTIONS, type Checkpoint, type GuardAction, type GuardInput } from './types.js';

/*
 * B-155: rule-set tests. A test case is a text with the context it arrives in (checkpoint, surface, channel, label,
 * role, account age) and what the set must make of it: `pass` (no rule fires), or `block`, `annotate` or `redact`,
 * usually naming the rule that must fire. Cases run against a version of the set's rules as if every rule enforced
 * (as shadow replay does), so a rule can be tested while it is still in shadow:
 *   - on every saved change of the set's draft (a job, `guardrail.tests.run`, queued only when the set has cases);
 *   - on demand;
 *   - before a version publishes, is approved or a rule is promoted to enforce: then a failing case refuses it (409).
 *
 * Texts may be harmful examples, so they are sealed at rest under the tenant's key with the case id as associated
 * data, carry the label they were given, and are shown only to someone cleared for it. A run keeps no text: case ids,
 * verdicts, and the rules that fired.
 */

export const EXPECTATIONS = ['pass', 'block', 'annotate', 'redact'] as const;
export type Expectation = (typeof EXPECTATIONS)[number];
export const MAX_CASES_PER_SET = 500;
const KEEP_RUNS = 20;
export const TESTS_JOB = 'guardrail.tests.run';

/** The expectation an action meets. */
export const categoryOf = (a: GuardAction): Expectation => (a === 'allow' ? 'pass' : a === 'redact' ? 'redact' : a === 'block' || a === 'require-approval' ? 'block' : 'annotate');

const ruleId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const word = (max: number) => z.string().trim().min(1).max(max);
export const testContextSchema = z
  .object({
    checkpoint: z.enum(CHECKPOINTS).optional(),
    surface: word(100).optional(),
    channel: word(200).optional(),
    label: z.enum(LABELS).default('internal'),
    role: word(63).optional(),
    /** The clearance of the person the text comes from (for label rules); none when left out. */
    clearance: z.enum(LABELS).optional(),
    accountAgeDays: z.number().int().min(0).max(100_000).optional(),
    newAccount: z.boolean().optional(),
    spamScore: z.number().min(0).max(100).optional()
  })
  .strict();
export type TestContext = z.infer<typeof testContextSchema>;
export const testCaseSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    text: z.string().min(1).max(20_000),
    context: testContextSchema.default({ label: 'internal' }),
    expect: z.enum(EXPECTATIONS),
    ruleId: ruleId.nullable().optional()
  })
  .strict()
  .refine((c) => !(c.expect === 'pass' && c.ruleId), { message: 'A case that must pass names no rule', path: ['ruleId'] });
export type TestCaseInput = z.infer<typeof testCaseSchema>;
export const testCasePatchSchema = z
  .object({ name: z.string().trim().min(1).max(200).nullable().optional(), text: z.string().min(1).max(20_000).optional(), context: testContextSchema.optional(), expect: z.enum(EXPECTATIONS).optional(), ruleId: ruleId.nullable().optional() })
  .strict();

export type TestSource = 'manual' | 'csv' | 'replay' | 'decision';

interface CaseRow {
  id: string;
  tenant_id: string;
  set_id: string;
  name: string | null;
  text: string;
  label: Label;
  context: string;
  expect: Expectation;
  rule_id: string | null;
  source: TestSource;
  source_ref: string | null;
  created_by: string | null;
  created_at: number | string;
  updated_at: number | string;
}

export interface TestCase {
  id: string;
  setId: string;
  name: string | null;
  /** Null when the case's label is above the reader's clearance. */
  text: string | null;
  hidden: boolean;
  label: Label;
  context: TestContext;
  expect: Expectation;
  ruleId: string | null;
  source: TestSource;
  sourceRef: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CaseResult {
  id: string;
  name: string | null;
  expect: Expectation;
  ruleId: string | null;
  ok: boolean;
  /** The most severe action of the rules that fired, as if every rule enforced. */
  actual: GuardAction;
  checkpoint: Checkpoint;
  fired: { ruleId: string; ruleName: string; action: GuardAction; detail: string | null; explain?: RuleResult['explain'] }[];
  errors: { ruleId: string; error: string }[];
  /** Why a failing case failed, in a sentence. */
  reason: string | null;
}

export interface RunDiff {
  previous: { id: string; version: number | null; at: number; passed: number; failed: number } | null;
  /** Cases that passed in the previous run and fail now, and the other way round. */
  nowFailing: string[];
  nowPassing: string[];
  added: string[];
  removed: string[];
  /** What changed in the rules between the two runs. */
  rules: { added: string[]; removed: string[]; changed: { id: string; fields: string[] }[] };
}

export interface TestRun {
  id: string;
  setId: string;
  version: number | null;
  trigger: 'change' | 'manual' | 'publish' | 'approve' | 'promote';
  total: number;
  passed: number;
  failed: number;
  results: CaseResult[];
  createdBy: string | null;
  createdAt: number;
  diff: RunDiff;
}

const caseView = (r: CaseRow, text: string | null): TestCase => ({
  id: r.id,
  setId: r.set_id,
  name: r.name,
  text,
  hidden: text === null,
  label: r.label,
  context: json<TestContext>(r.context, { label: r.label }),
  expect: r.expect,
  ruleId: r.rule_id,
  source: r.source,
  sourceRef: r.source_ref,
  createdBy: r.created_by,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
});

const aad = (id: string) => `guardtest:${id}`;

export class RuleTestService {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly engine: GuardrailEngine,
    private readonly sets: RuleSetService,
    private readonly jobs: JobQueue
  ) {
    jobs.register(TESTS_JOB, async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const set = await this.sets.get(tenantId, String(p.setId));
      if (!(await this.count(tenantId, set.id))) return { skipped: 'no cases' };
      const draft = await this.sets.draft(set.id);
      const v = draft ?? (await this.sets.published(set));
      const run = await this.run(tenantId, set, v?.rules ?? [], v?.version ?? null, 'change', null);
      return { run: run.id, version: run.version, total: run.total, passed: run.passed, failed: run.failed };
    });
    // Every saved change of a set's draft queues a run, for each tenant with cases on the set (one, except the baseline).
    sets.draftListeners.push((set, d) => void this.queueAfterChange(set, d).catch(() => undefined));
  }

  private async queueAfterChange(set: RuleSetRow, d: VersionRow): Promise<void> {
    const tenants = set.tenant_id ? [set.tenant_id] : ((await this.db('guard_rule_tests').where({ set_id: set.id }).distinct('tenant_id')) as { tenant_id: string }[]).map((x) => x.tenant_id);
    for (const tenantId of tenants) {
      if (!(await this.count(tenantId, set.id))) continue;
      await this.jobs.enqueue({ tenantId, type: TESTS_JOB, payload: { setId: set.id, version: d.version }, dedupeKey: `${TESTS_JOB}:${tenantId}:${set.id}:${d.version}:${d.updated_at}`, maxAttempts: 1 });
    }
  }

  async count(tenantId: string, setId: string): Promise<number> {
    const r = (await this.db('guard_rule_tests').where({ tenant_id: tenantId, set_id: setId }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return Number(r?.n ?? 0);
  }

  // ---------- cases ----------

  private async rows(tenantId: string, setId: string): Promise<CaseRow[]> {
    return (await this.db('guard_rule_tests').where({ tenant_id: tenantId, set_id: setId }).orderBy('created_at').orderBy('id')) as CaseRow[];
  }

  /** The set's cases; a text above the reader's clearance stays sealed (null, `hidden`). */
  async list(tenantId: string, setId: string, clearance: Label): Promise<TestCase[]> {
    const out: TestCase[] = [];
    for (const r of await this.rows(tenantId, setId)) out.push(caseView(r, clears(clearance, r.label) ? await this.keys.open(tenantId, r.text, aad(r.id)) : null));
    return out;
  }

  async get(tenantId: string, setId: string, id: string): Promise<CaseRow> {
    const r = (await this.db('guard_rule_tests').where({ tenant_id: tenantId, set_id: setId, id }).first()) as CaseRow | undefined;
    if (!r) throw notFound('Test case');
    return r;
  }

  /** Adds cases; the caller has checked them and their labels against the author's clearance. */
  async add(tenantId: string, set: RuleSetRow, cases: (TestCaseInput & { source?: TestSource; sourceRef?: string | null })[], by: string): Promise<TestCase[]> {
    const have = await this.count(tenantId, set.id);
    if (have + cases.length > MAX_CASES_PER_SET) throw new HttpProblem(422, 'Too many test cases', `A rule set holds at most ${MAX_CASES_PER_SET} test cases; it has ${have} and this adds ${cases.length}.`, { extensions: { max: MAX_CASES_PER_SET } });
    const t = Date.now();
    const out: TestCase[] = [];
    for (const [i, c] of cases.entries()) {
      const id = ulid();
      const label = c.context.label ?? 'internal';
      const row: CaseRow = { id, tenant_id: tenantId, set_id: set.id, name: c.name ?? null, text: await this.keys.seal(tenantId, c.text, aad(id)), label, context: JSON.stringify({ ...c.context, label }), expect: c.expect, rule_id: c.ruleId ?? null, source: c.source ?? 'manual', source_ref: c.sourceRef ?? null, created_by: by, created_at: t + i, updated_at: t + i };
      await this.db('guard_rule_tests').insert(row);
      out.push(caseView(row, c.text));
    }
    return out;
  }

  async update(tenantId: string, setId: string, id: string, patch: z.infer<typeof testCasePatchSchema>): Promise<TestCase> {
    const r = await this.get(tenantId, setId, id);
    const context = patch.context ?? json<TestContext>(r.context, { label: r.label });
    const expect = patch.expect ?? r.expect;
    const rule = patch.ruleId !== undefined ? patch.ruleId : r.rule_id;
    if (expect === 'pass' && rule) throw new HttpProblem(422, 'Invalid test case', 'A case that must pass names no rule.');
    const text = patch.text ?? (await this.keys.open(tenantId, r.text, aad(r.id)));
    const next: Partial<CaseRow> = { name: patch.name !== undefined ? patch.name : r.name, text: await this.keys.seal(tenantId, text, aad(r.id)), label: context.label, context: JSON.stringify(context), expect, rule_id: rule, updated_at: Date.now() };
    await this.db('guard_rule_tests').where({ id: r.id }).update(next);
    return caseView({ ...r, ...next } as CaseRow, text);
  }

  async remove(tenantId: string, setId: string, id: string): Promise<CaseRow> {
    const r = await this.get(tenantId, setId, id);
    await this.db('guard_rule_tests').where({ id: r.id }).delete();
    return r;
  }

  // ---------- running ----------

  /** Runs every case of the set against `rules` and keeps the run (no text) with its diff from the previous one. */
  async run(tenantId: string, set: RuleSetRow, rules: Rule[], version: number | null, trigger: TestRun['trigger'], by: string | null): Promise<TestRun> {
    const results: CaseResult[] = [];
    for (const r of await this.rows(tenantId, set.id)) results.push(await this.runCase(tenantId, r, rules));
    const passed = results.filter((x) => x.ok).length;
    const t = Date.now();
    const prev = (await this.db('guard_rule_test_runs').where({ tenant_id: tenantId, set_id: set.id }).orderBy('created_at', 'desc').orderBy('id', 'desc').first()) as Record<string, unknown> | undefined;
    const id = ulid();
    await this.db('guard_rule_test_runs').insert({ id, tenant_id: tenantId, set_id: set.id, version, cause: trigger, total: results.length, passed, failed: results.length - passed, results: JSON.stringify(results), rules: JSON.stringify(rules), created_by: by, created_at: t });
    const old = (await this.db('guard_rule_test_runs').where({ tenant_id: tenantId, set_id: set.id }).orderBy('created_at', 'desc').orderBy('id', 'desc').offset(KEEP_RUNS).select('id')) as { id: string }[];
    if (old.length) await this.db('guard_rule_test_runs').whereIn('id', old.map((x) => x.id)).delete();
    return { id, setId: set.id, version, trigger, total: results.length, passed, failed: results.length - passed, results, createdBy: by, createdAt: t, diff: diffRuns(prev, results, rules) };
  }

  /** The latest run of a set, with its diff from the one before; null before the first. */
  async lastRun(tenantId: string, setId: string): Promise<TestRun | null> {
    const [last, prev] = (await this.db('guard_rule_test_runs').where({ tenant_id: tenantId, set_id: setId }).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(2)) as Record<string, unknown>[];
    if (!last) return null;
    const results = json<CaseResult[]>(last.results, []);
    return { id: String(last.id), setId, version: last.version == null ? null : Number(last.version), trigger: last.cause as TestRun['trigger'], total: Number(last.total), passed: Number(last.passed), failed: Number(last.failed), results, createdBy: (last.created_by as string | null) ?? null, createdAt: Number(last.created_at), diff: diffRuns(prev, results, json<Rule[]>(last.rules, [])) };
  }

  private async runCase(tenantId: string, r: CaseRow, rules: Rule[]): Promise<CaseResult> {
    const ctx = json<TestContext>(r.context, { label: r.label });
    const named = r.rule_id ? rules.find((x) => x.id === r.rule_id) : undefined;
    const checkpoint: Checkpoint = ctx.checkpoint ?? named?.checkpoint ?? 'user-input';
    const base = { id: r.id, name: r.name, expect: r.expect, ruleId: r.rule_id, checkpoint };
    const text = await this.keys.open(tenantId, r.text, aad(r.id));
    const meta: Record<string, unknown> = {};
    for (const k of ['surface', 'channel', 'role', 'accountAgeDays', 'newAccount', 'spamScore'] as const) if (ctx[k] !== undefined) meta[k] = ctx[k];
    const principal = ctx.clearance ? ({ tenantId, userId: '', roles: ctx.role ? [ctx.role] : [], clearance: ctx.clearance } as unknown as Principal) : undefined;
    // One input object for every rule of the case, so a classifier is asked once and the context is read once.
    const input: Pick<GuardInput, 'tenantId' | 'checkpoint' | 'text' | 'label' | 'principal' | 'meta'> = { tenantId, checkpoint, text, label: isLabel(ctx.label) ? ctx.label : r.label, meta, ...(principal ? { principal } : {}) };
    const fired: CaseResult['fired'] = [];
    const errors: CaseResult['errors'] = [];
    for (const rule of rules) {
      if (!rule.enabled || rule.checkpoint !== checkpoint) continue;
      const out = await this.engine.evaluate(rule, input);
      if (out.error) errors.push({ ruleId: rule.id, error: out.error });
      else if (out.hit) fired.push({ ruleId: rule.id, ruleName: rule.name, action: rule.action, detail: out.detail, ...(out.explain ? { explain: out.explain } : {}) });
    }
    const actual = fired.reduce<GuardAction>((a, f) => (GUARD_ACTIONS.indexOf(f.action) > GUARD_ACTIONS.indexOf(a) ? f.action : a), 'allow');
    let reason: string | null = null;
    if (errors.length) reason = `${errors.map((e) => e.ruleId).join(', ')} could not run: ${errors[0]!.error}`;
    else if (r.expect === 'pass') reason = categoryOf(actual) === 'pass' ? null : `expected to pass, but ${fired.filter((f) => f.action !== 'allow').map((f) => f.ruleId).join(', ')} fired (${actual})`;
    else if (r.rule_id) {
      const f = fired.find((x) => x.ruleId === r.rule_id);
      if (!named) reason = `the rule ${r.rule_id} is not in this version`;
      else if (!named.enabled) reason = `the rule ${r.rule_id} is turned off`;
      else if (!f) reason = `expected ${r.rule_id} to ${r.expect}, but it did not fire`;
      else if (categoryOf(f.action) !== r.expect) reason = `expected ${r.rule_id} to ${r.expect}, but its action is ${f.action}`;
    } else if (categoryOf(actual) !== r.expect) reason = `expected ${r.expect}, got ${actual}`;
    return { ...base, ok: reason === null, actual, fired, errors, reason };
  }

  /**
   * The gate before a version publishes, is approved or a rule is promoted: runs the cases against the rules about to
   * apply and refuses (409, with the failing cases) unless every case passes. A set without cases passes.
   */
  async gate(tenantId: string, set: RuleSetRow, rules: Rule[], version: number | null, trigger: 'publish' | 'approve' | 'promote', by: string): Promise<TestRun | null> {
    if (!(await this.count(tenantId, set.id))) return null;
    const run = await this.run(tenantId, set, rules, version, trigger, by);
    if (run.failed) {
      const failing = run.results.filter((x) => !x.ok).map((x) => ({ id: x.id, name: x.name, expect: x.expect, ruleId: x.ruleId, actual: x.actual, reason: x.reason }));
      throw new HttpProblem(409, 'Rule-set tests failing', `${run.failed} of ${run.total} test case${run.total === 1 ? '' : 's'} of ${set.name} fail${run.failed === 1 ? 's' : ''} against v${version ?? '?'}. Fix the rules or the cases, then try again.`, { extensions: { run: run.id, failing } });
    }
    return run;
  }

  // ---------- imports ----------

  /**
   * Cases from recorded decisions (`guard_decisions`: the inspected text sealed, kept for the retention window): only
   * those of the tenant, in the set's workspace for a workspace set, and at or below the importer's clearance; the
   * case keeps the decision's label. A decision already imported into the set is skipped.
   */
  async fromDecisions(p: Principal, set: RuleSetRow, picks: { decisionId: string; expect: Expectation; ruleId: string | null }[], source: TestSource, by: string): Promise<{ added: TestCase[]; skipped: { decisionId: string; reason: string }[] }> {
    const skipped: { decisionId: string; reason: string }[] = [];
    const have = new Set(((await this.db('guard_rule_tests').where({ tenant_id: p.tenantId, set_id: set.id }).whereNotNull('source_ref').select('source_ref')) as { source_ref: string }[]).map((x) => x.source_ref));
    const ids = [...new Set(picks.map((x) => x.decisionId))];
    const rows = ids.length ? ((await this.db('guard_decisions').where({ tenant_id: p.tenantId }).whereIn('id', ids).select('id', 'workspace_id', 'checkpoint', 'label', 'text', 'meta')) as { id: string; workspace_id: string | null; checkpoint: Checkpoint; label: Label; text: string | null; meta: string | null }[]) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const cases: (TestCaseInput & { source: TestSource; sourceRef: string })[] = [];
    for (const pick of picks) {
      const d = byId.get(pick.decisionId);
      if (!d || !d.text) skipped.push({ decisionId: pick.decisionId, reason: 'no longer recorded (decisions are kept 7 days)' });
      else if (set.scope === 'workspace' && d.workspace_id !== set.workspace_id) skipped.push({ decisionId: d.id, reason: 'from another workspace' });
      else if (!clears(p.clearance, d.label)) skipped.push({ decisionId: d.id, reason: `labelled ${d.label}, above your clearance` });
      else if (have.has(d.id) || cases.some((c) => c.sourceRef === d.id)) skipped.push({ decisionId: d.id, reason: 'already a test case of this set' });
      else {
        const meta = json<Record<string, unknown>>(d.meta, {});
        const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
        const surface = s(meta.surface, 100) ?? s(meta.objectType, 100) ?? s(meta.via, 100);
        const channel = s(meta.channel, 200) ?? s(meta.group, 200) ?? s(meta.conversationId, 200);
        const text = (await this.keys.open(p.tenantId, d.text, `guard:${d.id}`)).slice(0, 20_000);
        cases.push({ name: `From decision ${d.id.slice(-8)}`, text, context: { checkpoint: d.checkpoint, label: d.label, ...(surface ? { surface } : {}), ...(channel ? { channel } : {}) }, expect: pick.expect, ruleId: pick.expect === 'pass' ? null : pick.ruleId, source, sourceRef: d.id });
      }
    }
    return { added: cases.length ? await this.add(p.tenantId, set, cases, by) : [], skipped };
  }

  /** The decisions a replay job found a rule would hit (`hits` in its result), as picks for `fromDecisions`. */
  async replayHits(tenantId: string, set: RuleSetRow, jobId: string, ruleIds: string[] | null, expect: 'hit' | 'pass'): Promise<{ decisionId: string; expect: Expectation; ruleId: string | null }[]> {
    const job = await this.jobs.get(tenantId, jobId);
    if (!job || job.type !== 'guardrails.replay' || (job.payload as { setId?: string }).setId !== set.id) throw notFound('Replay');
    if (job.state !== 'succeeded') throw new HttpProblem(409, 'Replay not finished', `The replay is ${job.state}; import its hits once it has finished.`);
    const result = job.result as { version?: number; rules?: { id: string; action: GuardAction; hits?: string[] }[] } | null;
    const out: { decisionId: string; expect: Expectation; ruleId: string | null }[] = [];
    for (const r of result?.rules ?? []) {
      if (ruleIds && !ruleIds.includes(r.id)) continue;
      for (const d of r.hits ?? []) out.push({ decisionId: d, expect: expect === 'pass' ? 'pass' : categoryOf(r.action), ruleId: expect === 'pass' ? null : r.id });
    }
    return out;
  }
}

// ---------- CSV ----------

export const TEST_CSV_COLUMNS = ['name', 'text', 'expect', 'rule', 'checkpoint', 'label', 'surface', 'channel', 'role', 'account_age_days', 'new_account'] as const;

/**
 * Test cases from CSV: a header naming at least `text` and `expect` (and any of rule, checkpoint, label, surface,
 * channel, role, account_age_days, new_account, name). Rows that do not validate are reported with the reason; a row
 * whose text, context and expectation repeat an earlier row or an existing case is a duplicate.
 */
export function casesFromCsv(text: string, existing: { text: string | null; context: TestContext; expect: string; ruleId: string | null }[]): { cases: TestCaseInput[]; invalid: { row: number; reason: string }[]; duplicates: { row: number; of: string }[] } {
  const rows = parseCsv(text, MAX_CASES_PER_SET);
  const invalid: { row: number; reason: string }[] = [];
  const duplicates: { row: number; of: string }[] = [];
  const cases: TestCaseInput[] = [];
  if (!rows.length) return { cases, invalid, duplicates };
  const head = rows[0]!.map((c) => c.trim().toLowerCase());
  if (!head.includes('text') || !head.includes('expect')) return { cases, invalid: [{ row: 1, reason: 'the header must name text and expect' }], duplicates };
  const col = (r: string[], name: string) => {
    const i = head.indexOf(name);
    const v = i >= 0 ? (r[i] ?? '').trim() : '';
    return v === '' ? undefined : v;
  };
  const keyOf = (c: { text: string | null; context: TestContext; expect: string; ruleId: string | null }) => JSON.stringify([c.text, c.context.checkpoint ?? null, c.context.label ?? 'internal', c.context.surface ?? null, c.context.channel ?? null, c.context.role ?? null, c.expect, c.ruleId ?? null]);
  const seen = new Map<string, string>(existing.filter((e) => e.text !== null).map((e) => [keyOf(e), 'an existing case']));
  rows.slice(1).forEach((r, i) => {
    const row = i + 2;
    const age = col(r, 'account_age_days');
    const isNew = col(r, 'new_account');
    const candidate = {
      ...(col(r, 'name') ? { name: col(r, 'name') } : {}),
      text: r[head.indexOf('text')] ?? '',
      expect: (col(r, 'expect') ?? '').toLowerCase(),
      ...(col(r, 'rule') ? { ruleId: col(r, 'rule') } : {}),
      context: {
        label: col(r, 'label') ?? 'internal',
        ...(col(r, 'checkpoint') ? { checkpoint: col(r, 'checkpoint') } : {}),
        ...(col(r, 'surface') ? { surface: col(r, 'surface') } : {}),
        ...(col(r, 'channel') ? { channel: col(r, 'channel') } : {}),
        ...(col(r, 'role') ? { role: col(r, 'role') } : {}),
        ...(age !== undefined ? { accountAgeDays: Number(age) } : {}),
        ...(isNew !== undefined ? { newAccount: /^(1|true|yes)$/i.test(isNew) } : {})
      }
    };
    const parsed = testCaseSchema.safeParse(candidate);
    if (!parsed.success) return void invalid.push({ row, reason: parsed.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ') });
    const k = keyOf({ text: parsed.data.text, context: parsed.data.context, expect: parsed.data.expect, ruleId: parsed.data.ruleId ?? null });
    const of = seen.get(k);
    if (of) return void duplicates.push({ row, of });
    seen.set(k, `row ${row}`);
    cases.push(parsed.data);
  });
  return { cases, invalid, duplicates };
}

function diffRuns(prev: Record<string, unknown> | undefined, results: CaseResult[], rules: Rule[]): RunDiff {
  if (!prev) return { previous: null, nowFailing: [], nowPassing: [], added: results.map((x) => x.id), removed: [], rules: { added: rules.map((r) => r.id), removed: [], changed: [] } };
  const before = new Map(json<CaseResult[]>(prev.results, []).map((x) => [x.id, x]));
  const now = new Map(results.map((x) => [x.id, x]));
  const d = diffRules(json<Rule[]>(prev.rules, []), rules);
  return {
    previous: { id: String(prev.id), version: prev.version == null ? null : Number(prev.version), at: Number(prev.created_at), passed: Number(prev.passed), failed: Number(prev.failed) },
    nowFailing: results.filter((x) => !x.ok && before.get(x.id)?.ok === true).map((x) => x.id),
    nowPassing: results.filter((x) => x.ok && before.get(x.id)?.ok === false).map((x) => x.id),
    added: results.filter((x) => !before.has(x.id)).map((x) => x.id),
    removed: [...before.keys()].filter((id) => !now.has(id)),
    rules: { added: d.added.map((r) => r.id), removed: d.removed.map((r) => r.id), changed: d.changed.map((c) => ({ id: c.id, fields: c.fields })) }
  };
}
