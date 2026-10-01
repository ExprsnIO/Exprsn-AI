import { z } from 'zod';
import YAML from 'yaml';
import { parseYamlSafely, YamlLimitError } from '../platform/yaml.js';
import { LABELS } from '../authz/labels.js';
import { HttpProblem } from '../http/problem.js';
import { compilePattern } from './regex.js';
import { CHECKPOINTS, GUARD_ACTIONS, type GuardAction } from './types.js';

/**
 * The GuardrailRule schema. A rule belongs to a rule set (platform baseline, tenant, workspace or agent), watches one
 * checkpoint, and has one mechanism; it runs in `shadow` (recorded, never changes the outcome) or `enforce`. When the
 * mechanism cannot answer (the guard model is down, a classifier fails), `onError` decides: `closed` holds the turn,
 * `allow` lets it through and flags the fail-open decision.
 */
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'Lower-case letters, digits and hyphens');

export const mechanismSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pattern'), pattern: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal('pii'), detectors: z.array(z.enum(['*', 'email', 'phone', 'iban', 'payment_card', 'national_id'])).min(1).default(['*']), threshold: z.number().min(0).max(1).default(0.8) }).strict(),
  z.object({ kind: z.literal('secrets'), detectors: z.array(z.enum(['*', 'private_key', 'cloud_access_key', 'bearer_token', 'high_entropy'])).min(1).default(['*']), threshold: z.number().min(0).max(1).default(0.6) }).strict(),
  z.object({ kind: z.literal('label'), against: z.enum(['clearance', 'ceiling', 'fixed']), label: z.enum(LABELS).optional() }).strict(),
  z.object({ kind: z.literal('budget'), metric: z.enum(['tokens', 'chars', 'steps']), max: z.number().int().min(1).max(100_000_000) }).strict(),
  z.object({ kind: z.literal('allow-list'), field: z.enum(['domains']).default('domains'), values: z.array(z.string().trim().toLowerCase().min(1).max(253)).max(500) }).strict(),
  z.object({ kind: z.literal('meta'), key: z.string().trim().regex(/^[A-Za-z][\w.-]{0,62}$/), values: z.array(z.string().max(100)).min(1).max(50) }).strict(),
  z.object({ kind: z.literal('classifier'), classifier: slug, label: z.string().trim().min(1).max(100), threshold: z.number().min(0).max(1).optional() }).strict(),
  z.object({ kind: z.literal('guard-model'), profile: z.string().trim().min(1).max(63), categories: z.array(z.string().regex(/^S\d{1,2}$/)).max(20).default([]) }).strict()
]);
export type Mechanism = z.infer<typeof mechanismSchema>;

export const ruleSchema = z
  .object({
    id: slug,
    name: z.string().trim().min(1).max(200),
    checkpoint: z.enum(CHECKPOINTS),
    type: z.string().trim().min(1).max(40).default('pattern'),
    mechanism: mechanismSchema,
    action: z.enum(GUARD_ACTIONS),
    stage: z.enum(['shadow', 'enforce']).default('shadow'),
    onError: z.enum(['allow', 'closed']).default('closed'),
    severity: z.enum(['low', 'medium', 'high']).default('medium'),
    enabled: z.boolean().default(true),
    description: z.string().trim().max(1000).optional()
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const actionRank = (a: GuardAction): number => GUARD_ACTIONS.indexOf(a);
export const SEVERITY_SLA_MINUTES = { high: 60, medium: 240, low: 2880 } as const;

/** Mechanisms that can fail at run time (a model or a trained classifier); the rest are deterministic. */
export const fallible = (m: Mechanism): boolean => m.kind === 'guard-model' || m.kind === 'classifier';

/** Validates a list of rules: schema, unique ids, and patterns that compile under RE2. Throws a 422 problem. */
export function validateRules(input: unknown): Rule[] {
  const parsed = z.array(ruleSchema).max(500).safeParse(input);
  if (!parsed.success) {
    throw new HttpProblem(422, 'Invalid rule', 'The rules do not match the GuardrailRule schema.', { extensions: { errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  const seen = new Set<string>();
  for (const r of parsed.data) {
    if (seen.has(r.id)) throw new HttpProblem(422, 'Invalid rule', `Two rules share the id ${r.id}.`, { extensions: { ruleId: r.id } });
    seen.add(r.id);
    checkRule(r);
  }
  return parsed.data;
}

export function checkRule(r: Rule): void {
  if (r.mechanism.kind === 'pattern') {
    const c = compilePattern(r.mechanism.pattern);
    if (!c.ok) throw new HttpProblem(422, 'Invalid pattern', `RE2 rejected the pattern of ${r.id} at position ${c.error.pos}: ${c.error.msg}.`, { extensions: { ruleId: r.id, pattern: r.mechanism.pattern, ...c.error } });
  }
  if (r.mechanism.kind === 'label' && r.mechanism.against === 'fixed' && !r.mechanism.label) throw new HttpProblem(422, 'Invalid rule', `${r.id}: a fixed label check needs a label.`, { extensions: { ruleId: r.id } });
}

/** True when `candidate` would weaken `base` (same id at a lower precedence level): off, shadow, a milder action or failing open. */
export function relaxes(base: Rule, candidate: Rule): string | null {
  if (!base.enabled) return null;
  if (!candidate.enabled) return 'disables it';
  if (base.stage === 'enforce' && candidate.stage === 'shadow') return 'moves it to shadow';
  if (actionRank(candidate.action) < actionRank(base.action)) return `changes the action from ${base.action} to ${candidate.action}`;
  if (base.onError === 'closed' && candidate.onError === 'allow') return 'makes it fail open';
  if (candidate.checkpoint !== base.checkpoint) return 'moves it to another checkpoint';
  if (JSON.stringify(candidate.mechanism) !== JSON.stringify(base.mechanism)) return 'changes what it detects';
  return null;
}

// ---------- YAML ----------

export const rulesToYaml = (rules: Rule[]): string => YAML.stringify(rules, { lineWidth: 0 });

export function rulesFromYaml(text: string): unknown {
  try {
    // B-907: size, depth, node and alias caps (no aliases at all in rules).
    const doc = parseYamlSafely(text, { maxBytes: 512 * 1024, maxDepth: 16, maxAliases: 0 });
    return doc ?? [];
  } catch (err) {
    if (err instanceof YamlLimitError) throw new HttpProblem(422, 'Invalid YAML', err.message, { extensions: { line: err.line, col: null } });
    const e = err as { message?: string; linePos?: { line: number; col: number }[] };
    throw new HttpProblem(422, 'Invalid YAML', e.message?.split('\n')[0] ?? 'The YAML does not parse.', { extensions: { line: e.linePos?.[0]?.line ?? null, col: e.linePos?.[0]?.col ?? null } });
  }
}

// ---------- diff ----------

export interface RuleDiff {
  added: Rule[];
  removed: Rule[];
  changed: { id: string; name: string; fields: string[]; before: Rule; after: Rule }[];
  /** A unified, line-level diff of the two versions' YAML. */
  text: string;
}

export function diffRules(before: Rule[], after: Rule[]): RuleDiff {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  const changed: RuleDiff['changed'] = [];
  for (const [id, r] of a) {
    const old = b.get(id);
    if (!old) continue;
    const fields = (Object.keys({ ...old, ...r }) as (keyof Rule)[]).filter((k) => JSON.stringify(old[k]) !== JSON.stringify(r[k]));
    if (fields.length) changed.push({ id, name: r.name, fields, before: old, after: r });
  }
  const parts: string[] = [];
  for (const r of after) {
    const old = b.get(r.id);
    if (!old) parts.push(prefix(rulesToYaml([r]), '+'));
    else if (changed.some((c) => c.id === r.id)) parts.push(lineDiff(rulesToYaml([old]), rulesToYaml([r])));
  }
  for (const r of before) if (!a.has(r.id)) parts.push(prefix(rulesToYaml([r]), '-'));
  return { added: after.filter((r) => !b.has(r.id)), removed: before.filter((r) => !a.has(r.id)), changed, text: parts.join('\n') };
}

const prefix = (text: string, p: string) =>
  text
    .trimEnd()
    .split('\n')
    .map((l) => p + l)
    .join('\n');

/** Line diff by longest common subsequence: unchanged lines start with a space, others with - or +. */
export function lineDiff(from: string, to: string): string {
  const x = from.trimEnd().split('\n');
  const y = to.trimEnd().split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push(' ' + x[i]);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push('-' + x[i++]);
    else out.push('+' + y[j++]);
  }
  while (i < n) out.push('-' + x[i++]);
  while (j < m) out.push('+' + y[j++]);
  return out.join('\n');
}
