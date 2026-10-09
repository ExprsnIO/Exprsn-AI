import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { forbidden, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { generate, ModelUnavailable, parseJsonObject } from '../apps/ai.js';
import { checkRule, diffRules, ruleSchema, rulesToYaml, type Rule, type RuleDiff } from './rules.js';
import type { RuleSetRow } from './sets.js';
import { CHECKPOINTS, GUARD_ACTIONS, type Checkpoint } from './types.js';

/*
 * 1.7.0 (B-9601): a guardrail rule drafted from a description. The description passes the `user-input` checkpoint,
 * a published profile's model turns it into one rule (the same path as the low-code drafts of B-2207, `apps/ai.ts`),
 * the answer is validated with the GuardrailRule schema and the RE2 compiler, and the draft comes back with a diff
 * against the set's working rules. A draft is always in shadow: `stage` is forced before validation, and saving it
 * (the route's `save`) adds it to the set's open draft in shadow, so it records findings and changes nothing until
 * it is promoted (with the false-positive limit) and published (under the set's dual control).
 */

export const RULE_DRAFT_MARK = 'You write one guardrail rule for an AI platform from a description.';

export const RULE_DRAFT_SYSTEM = `${RULE_DRAFT_MARK} Answer with one JSON object and nothing else:
{"id": "lower-case-slug", "name": "Short name", "checkpoint": one of ${CHECKPOINTS.map((c) => `"${c}"`).join(', ')}, "mechanism": {...}, "action": one of ${GUARD_ACTIONS.map((a) => `"${a}"`).join(', ')}, "severity": "low" | "medium" | "high", "description": "one sentence"}
Mechanisms, pick the most deterministic that fits:
{"kind": "pii", "detectors": [any of "email", "phone", "iban", "payment_card", "national_id"], "threshold": 0.8} for personal data such as card numbers, emails, phone numbers, bank accounts and identity numbers;
{"kind": "secrets", "detectors": [any of "private_key", "cloud_access_key", "bearer_token", "high_entropy"], "threshold": 0.6} for credentials;
{"kind": "pattern", "pattern": "RE2 regular expression, no backreferences or lookarounds"} for words or phrases;
{"kind": "budget", "metric": "tokens" | "chars" | "steps", "max": number} for sizes;
{"kind": "allow-list", "field": "domains", "values": ["host.example"]} for domains a call may reach;
{"kind": "label", "against": "clearance" | "ceiling" | "fixed", "label": one of ${LABELS.map((l) => `"${l}"`).join(', ')}} for classification checks;
{"kind": "injection", "engine": "heuristic", "threshold": 0.6} for instructions hidden in untrusted content;
{"kind": "guard-model", "profile": "profile-name", "categories": ["S1"]} only for safety categories a guard model judges.
Checkpoints: "user-input" is what a person sends, "model-output" is an answer, "tool-call" is a proposed tool call, "context" is retrieved text, "memory" is a memory write, "export" is an export, "untrusted-content" is a tool or web result. "Hold for review" or "ask for approval" means the action "require-approval"; "withhold", "refuse" or "stop" means "block"; "mask" means "redact"; "note" means "warn".`;

export const ruleDraftSchema = z
  .object({
    prompt: z.string().trim().min(3).max(4000),
    profile: z.string().trim().min(1).max(63),
    /** The checkpoint the description is about, when the console knows it; the model's own choice otherwise. */
    checkpoint: z.enum(CHECKPOINTS).optional(),
    /** Adds a valid draft to the set's open draft, in shadow. */
    save: z.boolean().default(false)
  })
  .strict();
export type RuleDraftInput = z.infer<typeof ruleDraftSchema>;

export interface RuleDraft {
  /** The validated rule, always in shadow; null when the answer did not validate. */
  rule: Rule | null;
  /** What the model answered, after the shape was normalised, for the console to show beside the problems. */
  raw: Record<string, unknown>;
  yaml: string | null;
  valid: boolean;
  problems: string[];
  /** The set's working rules against the working rules plus the draft; null when the draft did not validate. */
  diff: RuleDiff | null;
  checkpoint: Checkpoint | null;
}

const slugOf = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

/** A rule id that is not taken in the set: the model's (or one from the name), then `-2`, `-3`… */
export function freeId(wanted: string, taken: Set<string>): string {
  const base = /^[a-z0-9][a-z0-9-]{0,62}$/.test(wanted) ? wanted : 'rule';
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base.slice(0, 60)}-${n}`;
    if (!taken.has(id)) return id;
  }
  return `${base.slice(0, 40)}-${Date.now()}`;
}

/** Turns the model's answer into a candidate rule: shadow, enabled, a free id, the mechanism's kind as its type. */
export function normaliseDraft(obj: Record<string, unknown>, working: Rule[], checkpoint: Checkpoint | undefined): Record<string, unknown> {
  const mech = obj.mechanism && typeof obj.mechanism === 'object' && !Array.isArray(obj.mechanism) ? (obj.mechanism as Record<string, unknown>) : null;
  const kind = mech && typeof mech.kind === 'string' ? mech.kind : undefined;
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 200) : 'Drafted rule';
  const wanted = slugOf(typeof obj.id === 'string' && obj.id.trim() ? obj.id : name);
  const out: Record<string, unknown> = {
    id: freeId(wanted, new Set(working.map((r) => r.id))),
    name,
    checkpoint: typeof obj.checkpoint === 'string' && (CHECKPOINTS as readonly string[]).includes(obj.checkpoint) ? obj.checkpoint : (checkpoint ?? obj.checkpoint ?? 'model-output'),
    type: typeof obj.type === 'string' && obj.type.trim() ? obj.type.trim().slice(0, 40) : (kind ?? 'pattern'),
    mechanism: mech ?? obj.mechanism,
    action: typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : obj.action,
    stage: 'shadow',
    onError: 'closed',
    severity: typeof obj.severity === 'string' && ['low', 'medium', 'high'].includes(obj.severity) ? obj.severity : 'medium',
    enabled: true
  };
  if (typeof obj.description === 'string' && obj.description.trim()) out.description = obj.description.trim().slice(0, 1000);
  // Hold and approval wordings the model may echo back as an action.
  if (out.action === 'hold' || out.action === 'approval' || out.action === 'approve') out.action = 'require-approval';
  if (out.action === 'mask') out.action = 'redact';
  if (out.action === 'refuse' || out.action === 'withhold' || out.action === 'stop') out.action = 'block';
  return out;
}

/** Validates a candidate: schema, the RE2 pattern, and the shadow stage that a draft must keep. */
export function validateDraft(candidate: Record<string, unknown>): { rule: Rule | null; problems: string[] } {
  const parsed = ruleSchema.safeParse(candidate);
  if (!parsed.success) return { rule: null, problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'rule'}: ${i.message}`) };
  const rule: Rule = { ...parsed.data, stage: 'shadow' };
  try {
    checkRule(rule);
  } catch (err) {
    return { rule: null, problems: [err instanceof HttpProblem ? err.detail || err.message : (err as Error).message] };
  }
  return { rule, problems: [] };
}

export async function draftRule(
  s: Services,
  actor: { principal: Principal; ip?: string | null; traceId?: string | null },
  set: RuleSetRow,
  working: Rule[],
  input: Omit<RuleDraftInput, 'save'>,
  label: Label
): Promise<RuleDraft> {
  const p = actor.principal;
  // The draft is a model call made as the admin: it needs `inference:invoke` (a member's permission) besides `guardrails:manage`.
  const can = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label });
  if (!can.allow) throw forbidden(`Drafting a rule asks a model as you, which needs inference:invoke: ${can.reason}`, { step: can.step });
  const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: input.prompt, label, principal: p, source: { kind: 'guardrail-draft', id: set.id } });
  if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Description refused', `The description was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`);
  const system = input.checkpoint ? `${RULE_DRAFT_SYSTEM}\nThe rule watches the "${input.checkpoint}" checkpoint.` : RULE_DRAFT_SYSTEM;
  let text: string;
  try {
    text = await generate(s, { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, profile: input.profile, system, prompt: g.action === 'redact' ? g.text : input.prompt, label, principal: p, userId: p.userId, json: true, source: { kind: 'guardrail-draft', id: set.id } });
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
    throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
  }
  const candidate = normaliseDraft(parseJsonObject(text), working, input.checkpoint);
  const { rule, problems } = validateDraft(candidate);
  const out: RuleDraft = {
    rule,
    raw: candidate,
    yaml: rule ? rulesToYaml([rule]) : null,
    valid: !!rule,
    problems,
    diff: rule ? diffRules(working, [...working, rule]) : null,
    checkpoint: rule?.checkpoint ?? null
  };
  await s.audit.append({ tenantId: p.tenantId, action: 'guardrails.rule.drafted', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { set: set.id, name: set.name, rule: rule?.id ?? null, checkpoint: out.checkpoint, profile: input.profile }, label, detail: { valid: out.valid, problems: problems.length, mechanism: rule?.mechanism.kind ?? null, action: rule?.action ?? null }, traceId: actor.traceId ?? null });
  return out;
}
