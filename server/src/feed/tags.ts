/*
 * Hashtags (B-2705). A tag is `#` followed by letters, digits or underscores (any script), at most 64 of them, not
 * glued to a word before it (`a#b` and `&#38;` are not tags) and not only digits (`#1` is a number). Tags are compared
 * in lower case after NFKC normalisation, so `#Café` and `#CAFÉ` are one tag. A post keeps at most MAX_TAGS.
 */

export const MAX_TAGS = 20;
export const TAG = /^[\p{L}\p{N}_]{1,64}$/u;

const FIND = /(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{M}\p{N}_]{1,64})(?![\p{L}\p{M}\p{N}_])/gu;

/** The canonical form of a tag (lower case, NFKC), or null when it is not one. */
export function normaliseTag(raw: string): string | null {
  const t = raw.normalize('NFKC').toLowerCase().replace(/^#/, '');
  if (!TAG.test(t) || /^\d+$/.test(t)) return null;
  return t;
}

/** The distinct tags of a text, in the order they first appear. */
export function extractTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').matchAll(FIND)) {
    const t = normaliseTag(m[2]!);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}
