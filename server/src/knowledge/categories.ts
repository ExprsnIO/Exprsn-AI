/*
 * Document categories (migration 043): a document is filed under paths such as `moderation/hate-speech/slurs`, a
 * category with its subcategories. A path is stored in one spelling, so a filter written by a person or a model
 * finds what another one filed: each level in lower case, spaces and underscores as hyphens.
 *
 * Pure: the migration's tool catalogue and the routes read the limits.
 */

/** How many categories one document carries. */
export const MAX_CATEGORIES = 12;
/** How many levels a category has: the category and up to five levels of subcategory. */
export const MAX_CATEGORY_DEPTH = 6;
/** The longest name of one level. */
export const MAX_CATEGORY_SEGMENT = 60;

export class CategoryError extends Error {}

/** A filter on categories: a document is in or under at least one of `any` and in or under every one of `all`. */
export interface CategoryFilter {
  any?: string[];
  all?: string[];
}

/**
 * One category as it is stored. Levels are separated by `/` (or `>`); a level keeps letters, digits, `.`, `+`, `&`
 * and hyphens. Throws `CategoryError` saying what to change.
 */
export function categoryPath(raw: unknown): string {
  if (typeof raw !== 'string') throw new CategoryError('A category is text, such as "finance/reports/quarterly".');
  const levels = raw
    .split(/[/>]/)
    .map((x) =>
      x
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^\p{L}\p{N}.+&-]/gu, '')
        .replace(/-{2,}/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
    );
  if (!levels.length || levels.some((x) => !x)) throw new CategoryError(`"${raw.slice(0, 80)}" is not a category: name each level, separated by "/", such as "finance/reports/quarterly".`);
  if (levels.length > MAX_CATEGORY_DEPTH) throw new CategoryError(`"${raw.slice(0, 80)}" has ${levels.length} levels; a category has at most ${MAX_CATEGORY_DEPTH}.`);
  const long = levels.find((x) => x.length > MAX_CATEGORY_SEGMENT);
  if (long) throw new CategoryError(`"${long.slice(0, 20)}…" is longer than ${MAX_CATEGORY_SEGMENT} characters; shorten that level.`);
  return levels.join('/');
}

/**
 * A list of categories as stored, without repeats and without a category another one in the list is under (filing
 * under `a/b` already files under `a`).
 */
export function categoryPaths(raw: unknown, max = MAX_CATEGORIES): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new CategoryError('Categories are a list of paths, such as ["finance/reports/quarterly"].');
  const all = [...new Set(raw.map(categoryPath))];
  const out = all.filter((p) => !all.some((q) => q.startsWith(`${p}/`))).sort();
  if (out.length > max) throw new CategoryError(`${out.length} categories; a document carries at most ${max}.`);
  return out;
}

/** A category and the categories it is under, outermost first: `a/b/c` gives `a`, `a/b`, `a/b/c`. */
export function categoryAncestors(path: string): string[] {
  const levels = path.split('/');
  return levels.map((_, i) => levels.slice(0, i + 1).join('/'));
}

/** A filter with its paths as stored, or undefined when it names none. */
export function categoryFilter(any: unknown, all?: unknown): CategoryFilter | undefined {
  const a = categoryPaths(any, 20);
  const b = categoryPaths(all, 20);
  return a.length || b.length ? { ...(a.length ? { any: a } : {}), ...(b.length ? { all: b } : {}) } : undefined;
}

/**
 * Migration 046: the category a vision classifier's label files an image under, `images/<classifier>/<label>` (a
 * classifier slug's leading `image-` is left out: `image-kind` and `screenshot` give `images/kind/screenshot`), or
 * null when the label does not make a category.
 */
export function labelCategory(classifierSlug: string, label: string): string | null {
  try {
    return categoryPath(`images/${classifierSlug.replace(/^image-/, '')}/${label.replace(/[/>]/g, '-')}`);
  } catch {
    return null;
  }
}
