import { z } from 'zod';
import { LABELS, labelRank } from '../authz/labels.js';
import { compareValue, treeDepth, treeLeaves, treeSchema, type Tree, type TreeExplain } from '../platform/condition-tree.js';

/*
 * B-157: a rule's trigger as an `all`/`any`/`none` tree (the shape app flows use, `platform/condition-tree.ts`), up
 * to four groups deep. Leaves are mechanisms (an RE2 pattern, a term list, classifier categories each with its own
 * threshold, a PII or secrets detector) and facts about the check (surface, channel, label, role, account age,
 * whether the person is new, and the account's spam score). A rule whose mechanism is not `conditions` is evaluated
 * exactly as before.
 */

export const MAX_CONDITION_DEPTH = 4;
export const MAX_CONDITION_LEAVES = 30;
/** An account younger than this many days is new. */
export const NEW_ACCOUNT_DAYS = 7;

export const CONTEXT_FIELDS = ['surface', 'channel', 'label', 'role', 'accountAgeDays', 'newAccount', 'spamScore'] as const;
export type ContextField = (typeof CONTEXT_FIELDS)[number];
export const CONTEXT_OPS = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'truthy', 'falsy', 'exists', 'not_exists'] as const;
const NUMERIC: ContextField[] = ['accountAgeDays', 'spamScore'];
const ORDERED_OPS = ['gt', 'gte', 'lt', 'lte'];
const NO_VALUE = ['truthy', 'falsy', 'exists', 'not_exists'];

const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
const termRef = { list: z.string().length(26), version: z.union([z.literal('latest'), z.number().int().min(1)]).default('latest') };
export const termListMechanism = z.object({ kind: z.literal('term-list'), ...termRef, except: z.object(termRef).strict().optional() }).strict();

const categoryKey = z.string().trim().min(1).max(100);
export const conditionLeafSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pattern'), pattern: z.string().min(1).max(2000) }).strict(),
  termListMechanism,
  /** Classifier categories with a threshold each (Llama Guard's S1 to S14 on the `safety` classifier by default). */
  z.object({ kind: z.literal('category'), classifier: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default('safety'), thresholds: z.record(categoryKey, z.number().min(0).max(1)).refine((t) => Object.keys(t).length >= 1 && Object.keys(t).length <= 20, 'one to twenty categories') }).strict(),
  z.object({ kind: z.literal('detector'), family: z.enum(['pii', 'secrets']), detectors: z.array(z.string().regex(/^(\*|[a-z_]{1,40})$/)).min(1).max(10).default(['*']), threshold: z.number().min(0).max(1).default(0.8) }).strict(),
  z.object({ kind: z.literal('context'), field: z.enum(CONTEXT_FIELDS), op: z.enum(CONTEXT_OPS), value: z.union([scalar, z.array(scalar).max(50)]).optional() }).strict()
]);
export type ConditionLeaf = z.infer<typeof conditionLeafSchema>;
export type ConditionTree = Tree<ConditionLeaf>;
export const conditionTreeSchema: z.ZodType<ConditionTree> = treeSchema(conditionLeafSchema, 20);

/** Problems with a tree beyond its shape: depth, size, and operators that suit the field. Empty when it can run. */
export function conditionProblems(tree: ConditionTree): string[] {
  const out: string[] = [];
  if (treeDepth(tree) > MAX_CONDITION_DEPTH) out.push(`groups nest at most ${MAX_CONDITION_DEPTH} deep`);
  const leaves = treeLeaves(tree);
  if (leaves.length > MAX_CONDITION_LEAVES) out.push(`at most ${MAX_CONDITION_LEAVES} conditions (it has ${leaves.length})`);
  if (!leaves.length) out.push('a condition tree needs at least one condition');
  for (const l of leaves) {
    if (l.kind !== 'context') continue;
    const what = `${l.field} ${l.op}`;
    if (NO_VALUE.includes(l.op)) {
      if (l.value !== undefined) out.push(`${what} takes no value`);
      continue;
    }
    if (l.value === undefined) {
      out.push(`${what} takes a value`);
      continue;
    }
    if (l.op === 'in' || l.op === 'not_in') {
      if (!Array.isArray(l.value) || !l.value.length) out.push(`${what} takes a list of values`);
    } else if (Array.isArray(l.value)) out.push(`${what} takes one value`);
    if (ORDERED_OPS.includes(l.op) && !NUMERIC.includes(l.field) && l.field !== 'label') out.push(`${what}: only accountAgeDays, spamScore and label are ordered`);
    if (NUMERIC.includes(l.field) && !Array.isArray(l.value) && typeof l.value !== 'number') out.push(`${what} compares with a number`);
    if (l.field === 'label') for (const v of [l.value].flat()) if (!(LABELS as readonly string[]).includes(String(v))) out.push(`${what}: ${String(v)} is not a label`);
  }
  return out;
}

/** What a check knows about where it runs and who it is for. */
export interface CheckContext {
  surface: string | null;
  channel: string | null;
  label: string;
  role: string[];
  accountAgeDays: number | null;
  newAccount: boolean | null;
  /** 0 to 100, or null when unknown (no score source, no person, or the store did not answer in time). */
  spamScore: number | null;
  spamReasons?: { signal: string; value: number; threshold: number }[];
}

/** Compares a context leaf with the check's facts. Labels compare by rank; an unknown fact makes the leaf false. */
export function contextMatches(l: Extract<ConditionLeaf, { kind: 'context' }>, c: CheckContext): boolean {
  const left = c[l.field];
  if (l.op === 'exists' || l.op === 'not_exists') return compareValue(l.op, left, undefined);
  // An unknown fact (no account, no score) makes every other test false: a rule never fires on what it cannot know.
  if (left === null || left === undefined) return false;
  if (l.field === 'label') {
    const rank = (v: unknown) => labelRank(String(v) as (typeof LABELS)[number]);
    const right = Array.isArray(l.value) ? l.value.map(rank) : rank(l.value);
    return compareValue(l.op, rank(left), right);
  }
  return compareValue(l.op, left, l.value);
}

/** One leaf's account for the explanation. */
export interface LeafDetail {
  /** The leaf in words ("pattern (?i)free", "S10 ≥ 0.80", "accountAgeDays < 7"). */
  test: string;
  score?: number | null;
  detail?: string | null;
  /** The facts a context leaf saw (its field's value; the spam score's reasons when it matched). */
  value?: unknown;
  reasons?: { signal: string; value: number; threshold: number }[];
}
export type ConditionExplain = TreeExplain<LeafDetail>;

const OP_TEXT: Record<string, string> = { eq: '=', ne: '≠', in: 'is one of', not_in: 'is none of', gt: '>', gte: '≥', lt: '<', lte: '≤', truthy: 'is true', falsy: 'is false', exists: 'is known', not_exists: 'is unknown' };
export function leafText(l: ConditionLeaf): string {
  switch (l.kind) {
    case 'pattern':
      return `pattern ${l.pattern.slice(0, 80)}`;
    case 'term-list':
      return `term list ${l.list}@${l.version}`;
    case 'category':
      return `${l.classifier}: ${Object.entries(l.thresholds).map(([k, v]) => `${k} ≥ ${v.toFixed(2)}`).join(' or ')}`;
    case 'detector':
      return `${l.family} detector ${l.detectors.join(',')} ≥ ${l.threshold.toFixed(2)}`;
    case 'context':
      return `${l.field} ${OP_TEXT[l.op] ?? l.op}${l.value === undefined ? '' : ` ${Array.isArray(l.value) ? l.value.join(', ') : String(l.value)}`}`;
  }
}

/** The term lists a tree refers to (for the reference check when a rule is saved, and "used by"). */
export const treeTermRefs = (tree: ConditionTree) => treeLeaves(tree).flatMap((l) => (l.kind === 'term-list' ? [{ list: l.list, version: l.version }, ...(l.except ? [{ list: l.except.list, version: l.except.version }] : [])] : []));
/** True when a leaf calls a classifier (which can fail, and may call a model). */
export const treeIsFallible = (tree: ConditionTree) => treeLeaves(tree).some((l) => l.kind === 'category');
