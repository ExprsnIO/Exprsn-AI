import type { EntryRow, RegistryScope, RegistryService } from './service.js';

/*
 * Skills compose (B-4103). A skill lists the `skills` it builds on and the `tools` it needs; loading a skill loads its
 * closure: every skill it needs, transitively, each once, depth-first in listing order with a skill's dependencies
 * before it (so the instructions a skill builds on come first), and the tools of all of them, deduplicated in the same
 * order. A cycle (A needs B needs A) ends where it meets a skill already in the closure; the registry's publish checks
 * report cycles anyway (B-4105). The closure is capped at `MAX_CLOSURE` skills.
 */

export const MAX_CLOSURE = 32;

export const skillNames = (e: Pick<EntryRow, 'definition'>, key: 'skills' | 'tools'): string[] =>
  Array.isArray(e.definition[key]) ? (e.definition[key] as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];

export interface SkillClosure {
  /** Every skill to load, dependencies first, each once. */
  skills: EntryRow[];
  /** The tools they need, deduplicated, in the skills' order. */
  tools: string[];
  /** Names that could not be loaded, with the skill that asked for them (null: asked for directly). */
  missing: { name: string; neededBy: string | null; reason: string }[];
}

/** Resolves the closure of `names` as published to `scope` (the run's or the workflow's workspace). */
export async function skillClosure(registry: Pick<RegistryService, 'resolve'>, scope: RegistryScope, names: string[]): Promise<SkillClosure> {
  const out: SkillClosure = { skills: [], tools: [], missing: [] };
  const seen = new Set<string>();
  const visit = async (name: string, neededBy: string | null): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    if (out.skills.length >= MAX_CLOSURE) {
      out.missing.push({ name, neededBy, reason: `a skill loads at most ${MAX_CLOSURE} skills with what they need` });
      return;
    }
    const e = await registry.resolve(scope, name, 'skill');
    if (!e) {
      out.missing.push({ name, neededBy, reason: 'is not published to this workspace' });
      return;
    }
    for (const sub of skillNames(e, 'skills')) await visit(sub, e.name);
    out.skills.push(e);
    for (const t of skillNames(e, 'tools')) if (!out.tools.includes(t)) out.tools.push(t);
  };
  for (const n of names) await visit(n, null);
  return out;
}
