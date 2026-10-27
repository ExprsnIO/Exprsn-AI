import { z } from 'zod';

/*
 * The condition tree that app flows (`apps/flows.ts`) and guardrail rules (`guardrails/conditions.ts`, B-157) share:
 * `all`, `any` and `none` groups over leaves of the caller's own kind. Flows compile a tree into Workflows branch
 * steps; guardrails evaluate it directly with `evaluateTree`. Both read the same shape, depth and leaves from here, so
 * the two cannot drift apart.
 *
 * Semantics: `all` matches when every child matches (an empty `all` matches), `any` when at least one does (an empty
 * `any` does not), `none` when no child does (an empty `none` matches). This is the meaning `compileCondition` in
 * `apps/flows.ts` gives the same groups.
 */

export type Tree<L> = L | { all: Tree<L>[] } | { any: Tree<L>[] } | { none: Tree<L>[] };
export const GROUP_KINDS = ['all', 'any', 'none'] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

/** A tree schema over a leaf schema: the leaf, or a group of at most `maxChildren` subtrees. */
export function treeSchema<L>(leaf: z.ZodType<L>, maxChildren: number): z.ZodType<Tree<L>> {
  const self: z.ZodType<Tree<L>> = z.lazy(() =>
    z.union([leaf, z.object({ all: z.array(self).max(maxChildren) }).strict(), z.object({ any: z.array(self).max(maxChildren) }).strict(), z.object({ none: z.array(self).max(maxChildren) }).strict()])
  ) as z.ZodType<Tree<L>>;
  return self;
}

/** The group a node is, with its children; null for a leaf. */
export function groupOf<L>(c: Tree<L>): { kind: GroupKind; children: Tree<L>[] } | null {
  if (c && typeof c === 'object') {
    if ('all' in c && Array.isArray((c as { all: unknown }).all)) return { kind: 'all', children: (c as { all: Tree<L>[] }).all };
    if ('any' in c && Array.isArray((c as { any: unknown }).any)) return { kind: 'any', children: (c as { any: Tree<L>[] }).any };
    if ('none' in c && Array.isArray((c as { none: unknown }).none)) return { kind: 'none', children: (c as { none: Tree<L>[] }).none };
  }
  return null;
}

/** Every leaf, in order. */
export function treeLeaves<L>(c: Tree<L>): L[] {
  const g = groupOf(c);
  return g ? g.children.flatMap((x) => treeLeaves(x)) : [c as L];
}

/** Group nesting: a leaf is 0, a group of leaves 1. */
export function treeDepth<L>(c: Tree<L>): number {
  const g = groupOf(c);
  return g ? 1 + Math.max(0, ...g.children.map((x) => treeDepth(x))) : 0;
}

/** What evaluating one node found, for "explain": which branch matched, and why. */
export interface TreeExplain<D> {
  /** `all`, `any`, `none`, or `leaf`. */
  kind: GroupKind | 'leaf';
  /** The node's place in the tree, `0` for the root, `0.1.2` for the third child of the second child. */
  path: string;
  matched: boolean;
  /** False when an earlier sibling already decided the group, so this node was not evaluated. */
  evaluated: boolean;
  /** A leaf's own account (what it tested, its score). */
  detail?: D;
  children?: TreeExplain<D>[];
}

/**
 * Evaluates a tree with `leafFn`, left to right, stopping a group as soon as its result is known (an `all` at the
 * first miss, an `any` and a `none` at the first match), so expensive leaves after a decided branch never run. The
 * nodes not evaluated are still listed in the explanation, marked `evaluated: false`.
 */
export async function evaluateTree<L, D>(tree: Tree<L>, leafFn: (leaf: L, path: string) => Promise<{ matched: boolean; detail?: D }> | { matched: boolean; detail?: D }, path = '0'): Promise<TreeExplain<D>> {
  const g = groupOf(tree);
  if (!g) {
    const r = await leafFn(tree as L, path);
    return { kind: 'leaf', path, matched: r.matched, evaluated: true, ...(r.detail !== undefined ? { detail: r.detail } : {}) };
  }
  const children: TreeExplain<D>[] = [];
  let decided: boolean | null = null;
  for (const [i, child] of g.children.entries()) {
    const p = `${path}.${i}`;
    if (decided !== null) {
      children.push(skipped(child, p));
      continue;
    }
    const r = await evaluateTree(child, leafFn, p);
    children.push(r);
    if (g.kind === 'all' && !r.matched) decided = false;
    else if (g.kind === 'any' && r.matched) decided = true;
    else if (g.kind === 'none' && r.matched) decided = false;
  }
  const matched = decided ?? (g.kind === 'any' ? false : true);
  return { kind: g.kind, path, matched, evaluated: true, children };
}

function skipped<L, D>(tree: Tree<L>, path: string): TreeExplain<D> {
  const g = groupOf(tree);
  if (!g) return { kind: 'leaf', path, matched: false, evaluated: false };
  return { kind: g.kind, path, matched: false, evaluated: false, children: g.children.map((c, i) => skipped<L, D>(c, `${path}.${i}`)) };
}

/** The leaves that decided a match: matched leaves on evaluated branches whose groups matched. */
export function matchedLeaves<D>(e: TreeExplain<D>): TreeExplain<D>[] {
  if (!e.evaluated) return [];
  if (e.kind === 'leaf') return e.matched ? [e] : [];
  if (!e.matched) return [];
  // A `none` group matches because its children did not: nothing under it is a reason.
  if (e.kind === 'none') return [];
  return (e.children ?? []).flatMap((c) => matchedLeaves(c));
}

/**
 * A comparison of one value, with the operators of flows' leaves (and the Workflows branch step they compile to):
 * `eq` and `ne` compare as strings as well as by identity, `contains` tests an array's members or a substring, the
 * ordering operators compare numbers and are false when either side is not one, `in` and `not_in` test a list.
 * A left side that is an array matches `eq` and `in` when any member does (a person's roles).
 */
export function compareValue(op: string, left: unknown, right: unknown): boolean {
  const same = (a: unknown, b: unknown) => a === b || String(a) === String(b);
  switch (op) {
    case 'truthy':
      return !!left && !(Array.isArray(left) && !left.length);
    case 'falsy':
      return !compareValue('truthy', left, right);
    case 'exists':
      return left !== undefined && left !== null;
    case 'not_exists':
      return left === undefined || left === null;
    case 'contains':
      return Array.isArray(left) ? left.some((x) => same(x, right)) : String(left ?? '').includes(String(right ?? ''));
    case 'not_contains':
      return !compareValue('contains', left, right);
    case 'eq':
      return Array.isArray(left) ? left.some((x) => same(x, right)) : same(left, right);
    case 'ne':
      return !compareValue('eq', left, right);
    case 'in': {
      const list = Array.isArray(right) ? right : [right];
      return list.some((v) => compareValue('eq', left, v));
    }
    case 'not_in':
      return !compareValue('in', left, right);
    default: {
      const a = Number(left);
      const b = Number(right);
      if (left == null || typeof left === 'boolean' || !Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}
