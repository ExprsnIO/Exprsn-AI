import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, labelRank } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, forbidden, HttpProblem } from '../http/problem.js';
import { RETENTION_DAYS } from '../guardrails/engine.js';
import { casesFromCsv, EXPECTATIONS, testCasePatchSchema, testCaseSchema, type TestRun } from '../guardrails/rule-tests.js';
import type { Rule } from '../guardrails/rules.js';
import type { RuleSetRow } from '../guardrails/sets.js';
import type { Services } from '../services.js';

const caseId = z.string().length(26);
const ruleIdParam = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

const audit = (s: Services, req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
  const p = principalOf(req);
  return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
};

/**
 * B-155: the gate before a version of a set publishes, is approved, or a rule of it is promoted to enforce. Runs the
 * set's test cases against `rules`; a failing case refuses with 409 (and the audit entry `guardrail.tests.gate.refused`).
 * Returns the run, or null when the set has no cases, for the caller's own audit entry.
 */
export async function testsGate(s: Services, req: Request, set: RuleSetRow, rules: Rule[], version: number | null, trigger: 'publish' | 'approve' | 'promote'): Promise<TestRun | null> {
  const p = principalOf(req);
  try {
    const run = await s.guard.tests.gate(p.tenantId, set, rules, version, trigger, p.userId);
    if (run) await audit(s, req, 'guardrail.tests.gate.passed', { set: set.id, name: set.name, version }, { run: run.id, trigger, total: run.total });
    return run;
  } catch (err) {
    if (err instanceof HttpProblem && err.status === 409 && err.title === 'Rule-set tests failing') {
      const failing = (err.extensions?.failing ?? []) as { id: string }[];
      await audit(s, req, 'guardrail.tests.gate.refused', { set: set.id, name: set.name, version }, { trigger, run: err.extensions?.run, failing: failing.map((f) => f.id) });
    }
    throw err;
  }
}

/**
 * B-155: a rule set's test cases, their runs, and their imports, under `guardrails:manage` like the rule sets
 * themselves. Texts are sealed at rest and read back only by someone cleared for the case's label; a case cannot be
 * made above its author's clearance, and imports keep the label of the decision they come from.
 */
export function guardrailTestRoutes(s: Services): Router {
  const r = Router();
  const { sets, tests } = s.guard;
  r.use('/admin/guardrails/sets/:id/tests', noStore, requireAuth());
  const manage = requirePermission(s, 'guardrails:manage');
  const csvBody = express.text({ type: () => true, limit: '4mb' });

  const loadSet = (req: Request) => sets.get(principalOf(req).tenantId, String(req.params.id));
  const writable = (p: Principal, set: RuleSetRow) => {
    if (set.scope === 'platform' && !effectivePermissions(p).has('platform:manage')) throw forbidden('Baseline locked: the platform baseline is owned by platform guardrail admins.', { step: 'baseline-locked', owner: 'Platform guardrail admins' });
  };
  const cleared = (p: Principal, label: string) => {
    if (!clears(p.clearance, label as never)) throw new HttpProblem(400, 'Invalid request', `Your clearance is ${p.clearance}; a ${label} test case is above it.`);
  };
  /** The rules a run tests: the draft by default, else the published version, or a version by number. */
  const rulesFor = async (set: RuleSetRow, which: 'draft' | 'published' | number | undefined) => {
    const v = typeof which === 'number' ? await sets.version(set.id, which) : which === 'published' ? await sets.published(set) : ((await sets.draft(set.id)) ?? (await sets.published(set)));
    if (typeof which === 'number' && !v) throw new HttpProblem(404, 'Not found', `Version ${which} does not exist.`);
    return { rules: v?.rules ?? [], version: v?.version ?? null };
  };

  r.get('/admin/guardrails/sets/:id/tests', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    res.json({ cases: await tests.list(p.tenantId, set.id, p.clearance), lastRun: await tests.lastRun(p.tenantId, set.id) });
  });

  r.post('/admin/guardrails/sets/:id/tests', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const body = parseBody(z.object({ cases: z.array(testCaseSchema).min(1).max(100) }).strict().or(testCaseSchema.transform((c) => ({ cases: [c] }))), req.body);
    for (const c of body.cases) cleared(p, c.context.label);
    const added = await tests.add(p.tenantId, set, body.cases, p.userId);
    await audit(s, req, 'guardrail.tests.added', { set: set.id, name: set.name }, { cases: added.map((c) => c.id), source: 'manual' });
    res.status(201).json({ cases: added });
  });

  r.patch('/admin/guardrails/sets/:id/tests/:caseId', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const id = parseBody(caseId, req.params.caseId);
    const patch = parseBody(testCasePatchSchema, req.body);
    const row = await tests.get(p.tenantId, set.id, id);
    cleared(p, row.label);
    if (patch.context) cleared(p, patch.context.label);
    const c = await tests.update(p.tenantId, set.id, id, patch);
    await audit(s, req, 'guardrail.tests.updated', { set: set.id, name: set.name, case: id }, { fields: Object.keys(patch) });
    res.json(c);
  });

  r.delete('/admin/guardrails/sets/:id/tests/:caseId', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const id = parseBody(caseId, req.params.caseId);
    const row = await tests.remove(p.tenantId, set.id, id);
    await audit(s, req, 'guardrail.tests.removed', { set: set.id, name: set.name, case: id }, { expect: row.expect, rule: row.rule_id });
    res.status(204).end();
  });

  /** Runs the cases now, against the draft (default), the published version, or a version by number. */
  r.post('/admin/guardrails/sets/:id/tests/run', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    const body = parseBody(z.object({ version: z.union([z.enum(['draft', 'published']), z.number().int().min(1)]).optional() }).strict(), req.body ?? {});
    const { rules, version } = await rulesFor(set, body.version);
    const run = await tests.run(p.tenantId, set, rules, version, 'manual', p.userId);
    await audit(s, req, 'guardrail.tests.run', { set: set.id, name: set.name, version }, { run: run.id, total: run.total, passed: run.passed, failed: run.failed });
    res.json(run);
  });

  /**
   * Recorded decisions in which this set's rules fired (the last 7 days; text sealed in guard_decisions), at or below
   * the caller's clearance, as candidates for test cases: the excerpt, the label, and which rules fired.
   */
  r.get('/admin/guardrails/sets/:id/tests/decisions', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }), req.query);
    const query = s.db('guard_decisions').where({ tenant_id: p.tenantId }).andWhere('created_at', '>=', Date.now() - RETENTION_DAYS * 86_400_000).andWhere('findings', 'like', `%${set.id}%`).orderBy('created_at', 'desc').limit(500).select('id', 'workspace_id', 'checkpoint', 'label', 'action', 'text', 'findings', 'created_at');
    if (set.scope === 'workspace') query.andWhere({ workspace_id: set.workspace_id });
    const rows = (await query) as { id: string; checkpoint: string; label: string; action: string; text: string | null; findings: string | null; created_at: number | string }[];
    const out = [];
    for (const d of rows) {
      if (out.length >= q.limit) break;
      if (labelRank(d.label as never) > labelRank(p.clearance) || !d.text) continue;
      const fired = json<{ setId?: string; ruleId: string; action: string; stage: string; error?: string }[]>(d.findings, []).filter((f) => f.setId === set.id && !f.error);
      if (!fired.length) continue;
      const text = await s.keys.open(p.tenantId, d.text, `guard:${d.id}`);
      out.push({ id: d.id, at: Number(d.created_at), checkpoint: d.checkpoint, label: d.label, action: d.action, excerpt: text.slice(0, 200), rules: [...new Map(fired.map((f) => [f.ruleId, { ruleId: f.ruleId, action: f.action, stage: f.stage }])).values()] });
    }
    res.json(out);
  });

  r.post('/admin/guardrails/sets/:id/tests/import/decisions', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const body = parseBody(z.object({ decisions: z.array(z.object({ id: z.string().length(26), expect: z.enum(EXPECTATIONS), ruleId: ruleIdParam.nullable().optional() }).strict()).min(1).max(100) }).strict(), req.body);
    const out = await tests.fromDecisions(p, set, body.decisions.map((d) => ({ decisionId: d.id, expect: d.expect, ruleId: d.ruleId ?? null })), 'decision', p.userId);
    await audit(s, req, 'guardrail.tests.imported', { set: set.id, name: set.name }, { source: 'decision', cases: out.added.map((c) => c.id), skipped: out.skipped.length });
    res.status(201).json(out);
  });

  /** Cases from a finished shadow replay of this set: the recorded decisions each rule would have hit. */
  r.post('/admin/guardrails/sets/:id/tests/import/replay', manage, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const body = parseBody(z.object({ jobId: z.string().length(26), ruleIds: z.array(ruleIdParam).min(1).max(50).optional(), expect: z.enum(['hit', 'pass']).default('hit'), limit: z.number().int().min(1).max(100).default(20) }).strict(), req.body);
    const picks = (await tests.replayHits(p.tenantId, set, body.jobId, body.ruleIds ?? null, body.expect)).slice(0, body.limit);
    const out = await tests.fromDecisions(p, set, picks, 'replay', p.userId);
    await audit(s, req, 'guardrail.tests.imported', { set: set.id, name: set.name }, { source: 'replay', job: body.jobId, cases: out.added.map((c) => c.id), skipped: out.skipped.length });
    res.status(201).json(out);
  });

  /** Cases from CSV (text/csv body). `dryRun=true` reports what would be added, the invalid rows and the duplicates. */
  r.post('/admin/guardrails/sets/:id/tests/import/csv', manage, csvBody, async (req, res) => {
    const p = principalOf(req);
    const set = await loadSet(req);
    writable(p, set);
    const q = parseBody(z.object({ dryRun: z.enum(['true', 'false', '1', '0']).optional() }), req.query);
    const dryRun = q.dryRun === 'true' || q.dryRun === '1';
    if (typeof req.body !== 'string' || !req.body.trim()) throw badRequest('Send the CSV as the request body.');
    const existing = await tests.list(p.tenantId, set.id, p.clearance);
    const parsed = casesFromCsv(req.body, existing);
    const above = parsed.cases.map((c, i) => ({ c, i })).filter(({ c }) => !clears(p.clearance, c.context.label));
    const cases = parsed.cases.filter((c) => clears(p.clearance, c.context.label));
    const invalid = [...parsed.invalid, ...above.map(({ c }) => ({ row: 0, reason: `labelled ${c.context.label}, above your clearance` }))];
    if (dryRun) {
      res.json({ dryRun: true, valid: cases.length, invalid, duplicates: parsed.duplicates, preview: cases.slice(0, 20).map((c) => ({ name: c.name ?? null, expect: c.expect, ruleId: c.ruleId ?? null, context: c.context, excerpt: c.text.slice(0, 120) })) });
      return;
    }
    const added = cases.length ? await tests.add(p.tenantId, set, cases.map((c) => ({ ...c, source: 'csv' as const })), p.userId) : [];
    await audit(s, req, 'guardrail.tests.imported', { set: set.id, name: set.name }, { source: 'csv', cases: added.map((c) => c.id), invalid: invalid.length, duplicates: parsed.duplicates.length });
    res.status(201).json({ dryRun: false, added, invalid, duplicates: parsed.duplicates });
  });

  return r;
}
