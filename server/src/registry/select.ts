/*
 * Which of a profile's tools the model is offered on one turn (2.0.0).
 *
 * A profile may list hundreds of tools (chat, cortex, spark and knowledge list every published tool), while a local
 * model's context holds a few dozen definitions at most: ~380 definitions are ~95k tokens. When the list is longer than
 * `MAX_OFFERED`, the tools are ranked by how many of the turn's words their name and description share, and the best
 * are offered. Tools the turn pins (its skills' tools, calculate) are always kept and count toward the limit.
 */

/** The most tool definitions one model call is offered. */
export const MAX_OFFERED = 24;

const STOP = new Set('a an and are as at be by can do does for from get give how i in is it me my of on or please show tell that the this to use what when where which who why with you your'.split(' '));

/** The lower-case words of a text (3+ characters, or digits), without common words; names split on `._-:` and case. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => (w.length >= 3 || /^\d+$/.test(w)) && !STOP.has(w));
}

/** A crude stem, so "images" meets "image" and "searching" meets "search". */
const stem = (w: string) => w.replace(/(ings?|ed|es|s)$/, '') || w;

export interface Brief {
  name: string;
  description: string | null;
}

/**
 * The names ranked for a query: a word of the query in the tool's name counts three, in its description one. Ties
 * keep the profile's order, so a turn with no useful words is offered the first tools the profile lists.
 */
export function rankTools(briefs: Brief[], query: string): string[] {
  const q = new Set(words(query).map(stem));
  const scored = briefs.map((b, i) => {
    if (!q.size) return { name: b.name, score: 0, i };
    const inName = new Set(words(b.name).map(stem));
    const inText = new Set(words(b.description ?? '').map(stem));
    let score = 0;
    for (const w of q) score += (inName.has(w) ? 3 : 0) + (inText.has(w) ? 1 : 0);
    return { name: b.name, score, i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.name);
}
