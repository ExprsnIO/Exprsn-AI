import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { generate, ModelUnavailable, parseJsonObject } from '../apps/ai.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { checkRule, diffRules, ruleSchema, rulesToYaml, type Rule } from './rules.js';
import type { RuleSetRow, VersionRow } from './sets.js';
import { CHECKPOINTS } from './types.js';

/*
 * Guardrail rules drafted from a description (B-9601), on the low-code draft assistant's model call (B-2207,
 * `apps/ai.ts`): a local model, through the gateway and a published profile, turns an administrator's description into
 * one rule. The description passes the `user-input` checkpoint first and the answer the `model-output` one.
 *
 * The model's answer is untrusted. Only the fields named here are read from it; the rule's id, stage, `onError` and
 * `enabled` are set by the server; the mechanism must be one of the deterministic kinds, which name no profile and no
 * classifier; and the result is validated with the rule schema like any saved rule. A draft never changes the rules
 * that exist: it adds one rule, under an id no rule of the set or of the platform baseline has, in shadow. It is kept
 * in `guard_rule_drafts` as it was shown, and saving takes it from there, not from the request.
 *
 * A saved draft marks its rule as drafted by a model. A version in which such a rule enforces publishes only through
 * the existing dual control (request review, another guardrail admin approves) until one approval covered it.
 */

/** The mechanisms a draft may use: deterministic, and without references to profiles or classifiers. */
export const DRAFT_MECHANISMS = ['pattern', 'pii', 'secrets', 'budget', 'allow-list'] as const;
const TYPE_OF: Record<(typeof DRAFT_MECHANISMS)[number], string> = { pattern: 'pattern', pii: 'PII', secrets: 'secrets', budget: 'budget', 'allow-list': 'topic' };
const DRAFT_TTL_MS = 7 * 86_400_000;

export const RULE_DRAFT_SYSTEM = `You write one guardrail rule for an AI platform from an administrator's description. Answer with one JSON object and nothing else:
{"name": "Short name of the rule", "checkpoint": "...", "mechanism": {...}, "action": "...", "severity": "low" | "medium" | "high", "description": "One sentence on what it catches"}
Checkpoints: "user-input" (what a person sends), "model-output" (the model's answers), "context" (retrieved passages), "tool-call" (a tool call the model proposes), "memory", "script", "db-query", "export", "untrusted-content" (${CHECKPOINTS.length} exist: ${CHECKPOINTS.join(', ')}).
Mechanisms, pick one:
{"kind": "pii", "detectors": ["payment_card"], "threshold": 0.8} personal data by built-in detectors: email, phone, iban, payment_card, national_id, or "*" for any.
{"kind": "secrets", "detectors": ["*"], "threshold": 0.6} credentials: private_key, cloud_access_key, bearer_token, high_entropy, or "*".
{"kind": "pattern", "pattern": "(?i)an RE2 regular expression"} no backreferences and no lookaround.
{"kind": "budget", "metric": "tokens" | "chars" | "steps", "max": 4000} longer than the maximum triggers.
{"kind": "allow-list", "field": "domains", "values": ["example.com"]} a link to a host outside the list triggers.
Actions: "log", "warn", "flag" (for a reviewer, the turn goes on), "redact" (remove the matched text), "require-approval" (hold the turn until a reviewer decides), "block".
Prefer a detector to a pattern when one fits. Write only the rule the description asks for.`;

export const describeSchema = z.object({ description: z.string().trim().min(3).max(2000), profile: z.string().min(1).max(63) }).strict();

export interface DraftedMark {
  ruleId: string;
  by: string;
  at: number;
  profile: string;
  /** A second guardrail admin approved a version in which the rule enforces. */
  enforceApproved: boolean;
}

interface DraftRow {
  id: string;
  tenant_id: string;
  set_id: string;
  rule_id: string;
  rule: string;
  profile: string;
  status: 'drafted' | 'saved';
  created_by: string;
  created_at: number | string;
  saved_at: number | string | null;
  enforce_approved_at: number | string | null;
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56);
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The candidate rule read from a model's answer: only the fields a draft may set, the rest fixed here. */
function candidate(obj: Record<string, unknown>, taken: Set<string>): { rule: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const name = str(obj.name, 200) ?? 'Drafted rule';
  const base = slugOf(name) || 'drafted-rule';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  const m = obj.mechanism && typeof obj.mechanism === 'object' && !Array.isArray(obj.mechanism) ? (obj.mechanism as Record<string, unknown>) : null;
  const kind = m ? String(m.kind ?? '') : '';
  const draftable = (DRAFT_MECHANISMS as readonly string[]).includes(kind);
  if (!m) problems.push('mechanism: the draft names no mechanism');
  else if (!draftable) problems.push(`mechanism.kind: a drafted rule uses one of ${DRAFT_MECHANISMS.join(', ')}, not ${kind.slice(0, 40) || 'nothing'}`);
  const description = str(obj.description, 1000);
  const rule: Record<string, unknown> = {
    id,
    name,
    checkpoint: obj.checkpoint,
    type: draftable ? TYPE_OF[kind as (typeof DRAFT_MECHANISMS)[number]] : 'pattern',
    mechanism: m,
    action: obj.action,
    stage: 'shadow',
    onError: 'closed',
    severity: obj.severity ?? 'medium',
    enabled: true,
    ...(description ? { description } : {})
  };
  return { rule, problems };
}

const rowAt = (v: number | string | null): number => Number(v ?? 0);

/** Drafts one rule for a rule set from a description. Nothing in the set changes. */
export async function describeRule(s: Services, p: Principal, set: RuleSetRow, input: z.infer<typeof describeSchema>, label: Label, at: { ip?: string | null; traceId?: string | null } = {}) {
  const { sets } = s.guard;
  const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: input.description, label, principal: p, source: { kind: 'guardrail-draft', id: p.userId } });
  if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Description refused', `The description was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`);
  let text: string;
  try {
    text = await generate(s, { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, profile: input.profile, system: RULE_DRAFT_SYSTEM, prompt: g.action === 'redact' ? g.text : input.description, label, principal: p, userId: p.userId, json: true, source: { kind: 'guardrail-draft', id: p.userId } });
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
    throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
  }
  const obj = parseJsonObject(text);
  const working = await sets.workingRules(set);
  const taken = new Set([...working.map((r) => r.id), ...(await sets.baselineRules()).keys()]);
  const c = candidate(obj, taken);
  const problems = [...c.problems];
  let rule: Rule | null = null;
  if (!problems.length) {
    const parsed = ruleSchema.safeParse(c.rule);
    if (!parsed.success) problems.push(...parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`));
    else {
      try {
        checkRule(parsed.data);
        rule = parsed.data;
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err;
        problems.push(err.detail ?? err.message);
      }
    }
  }
  let id: string | null = null;
  const t = Date.now();
  // One open draft per person and set, and none older than a week: a draft that was not saved is dropped.
  await s.db('guard_rule_drafts').where({ set_id: set.id, status: 'drafted' }).andWhere((q) => q.where({ created_by: p.userId }).orWhere('created_at', '<', t - DRAFT_TTL_MS)).delete();
  if (rule) {
    id = ulid();
    await s.db('guard_rule_drafts').insert({ id, tenant_id: p.tenantId, set_id: set.id, rule_id: rule.id, rule: JSON.stringify(rule), profile: input.profile, status: 'drafted', created_by: p.userId, created_at: t, saved_at: null, saved_version: null, enforce_approved_by: null, enforce_approved_at: null });
  }
  await s.audit.append({ tenantId: p.tenantId, action: 'guardrails.rule.drafted', kind: 'admin', actor: actorFrom(p, at.ip ?? null), target: { set: set.id, name: set.name, profile: input.profile }, label, detail: { valid: !!rule, problems: problems.length, rule: rule?.id ?? null, draft: id }, traceId: at.traceId ?? null });
  const diff = rule ? diffRules(working, [...working, rule]) : null;
  return {
    id,
    valid: !!rule,
    problems,
    rule: rule ?? c.rule,
    yaml: rule ? rulesToYaml([rule]) : null,
    diff: diff ? { added: diff.added.map((r) => r.id), removed: [], changed: [], text: diff.text } : null,
    against: { set: set.id, name: set.name, version: (await sets.draft(set.id))?.version ?? set.published_version ?? null }
  };
}

/** Adds a drafted rule to the set's draft, in shadow, exactly as it was drafted. */
export async function saveDrafted(s: Services, p: Principal, set: RuleSetRow, draftId: string): Promise<{ version: VersionRow; rule: Rule }> {
  const { sets } = s.guard;
  const row = (await s.db('guard_rule_drafts').where({ id: draftId, tenant_id: p.tenantId, set_id: set.id }).first()) as DraftRow | undefined;
  if (!row || row.created_by !== p.userId) throw notFound('Drafted rule');
  if (row.status !== 'drafted') throw conflict('This drafted rule is already in the rule set.');
  const parsed = ruleSchema.safeParse(JSON.parse(row.rule));
  if (!parsed.success || !(DRAFT_MECHANISMS as readonly string[]).includes(parsed.data.mechanism.kind)) throw conflict('The drafted rule no longer matches the rule schema. Describe it again.');
  const rule: Rule = { ...parsed.data, stage: 'shadow', enabled: true };
  checkRule(rule);
  const working = await sets.workingRules(set);
  if (working.some((r) => r.id === rule.id) || (await sets.baselineRules()).has(rule.id)) throw conflict(`A rule with the id ${rule.id} exists now. Describe the rule again.`);
  const version = await sets.saveDraft(set, [...working, rule], p.userId);
  const t = Date.now();
  // An earlier rule of this id that was drafted and has since left the set gives its mark up to this one.
  await s.db('guard_rule_drafts').where({ set_id: set.id, rule_id: rule.id, status: 'saved' }).delete();
  await s.db('guard_rule_drafts').where({ id: row.id }).update({ status: 'saved', saved_at: t, saved_version: version.version });
  return { version, rule };
}

/** The rules of a set that were drafted by a model, by rule id. */
export async function draftedMarks(s: Services, setId: string): Promise<Map<string, DraftedMark>> {
  const rows = (await s.db('guard_rule_drafts').where({ set_id: setId, status: 'saved' })) as DraftRow[];
  return new Map(rows.map((r) => [r.rule_id, { ruleId: r.rule_id, by: r.created_by, at: rowAt(r.saved_at ?? r.created_at), profile: r.profile, enforceApproved: r.enforce_approved_at != null }]));
}

/** The drafted rules that enforce in `rules` without a second guardrail admin having approved them. */
export async function awaitingSecondApprover(s: Services, setId: string, rules: Rule[]): Promise<Rule[]> {
  const marks = await draftedMarks(s, setId);
  return rules.filter((r) => r.enabled && r.stage === 'enforce' && marks.get(r.id)?.enforceApproved === false);
}

/** Records that a second guardrail admin approved a version in which these drafted rules enforce. */
export async function markEnforceApproved(s: Services, setId: string, rules: Rule[], by: string): Promise<string[]> {
  const ids = (await awaitingSecondApprover(s, setId, rules)).map((r) => r.id);
  if (ids.length) await s.db('guard_rule_drafts').where({ set_id: setId, status: 'saved' }).whereIn('rule_id', ids).update({ enforce_approved_by: by, enforce_approved_at: Date.now() });
  return ids;
}
