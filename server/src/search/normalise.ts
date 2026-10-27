/*
 * 1.9.0, Sprint 52 (B-170): how text becomes index terms, how a query is read, and how a snippet is cut and marked.
 *
 * Normalisation (decided for B-170): Unicode NFKD, combining marks removed (accents: "café" → "cafe"), lower case,
 * words split on anything that is not a letter, a mark or a digit; words of one character or more than 40 are not kept,
 * nor the common English stop words; a light plural fold drops one final "s" from a word of more than three letters
 * that does not end in "ss" ("reports" → "report", "class" stays). No stemmer beyond that: the index holds hashes, so
 * a stemmer can never be changed without re-reading every document, and an aggressive one merges words across the
 * languages a tenant writes in. Scripts written without spaces (Chinese, Japanese, Thai) are kept as whole runs: they
 * match a whole run, not a word inside it (a known gap).
 *
 * Positions count kept words only, so a phrase with stop words in it ("state of the art") matches its kept words
 * side by side; the exact phrase is then checked on the opened text, for the reader only.
 */

const STOP = new Set(
  'a an and are as at be but by for from has have i in is it its of on or that the this to was were will with we you your our their they them he she his her not no do does did so if then than there these those which who what when where how can could should would may might been being into over under about after before also only other such any each more most very just'.split(' ')
);

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
export const MIN_PREFIX = 2;
export const MAX_PREFIX = 4;
export const MAX_TERM = 40;

/** A word folded (NFKD, no marks, lower case), before stop words and the plural fold. */
export function fold(raw: string): string {
  return raw.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

const plural = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The index term of a folded word, or null when it is not kept. */
export function termOf(folded: string): string | null {
  if (folded.length < 2 || folded.length > MAX_TERM || STOP.has(folded)) return null;
  return plural(folded);
}

export interface Word {
  /** The word as written. */
  raw: string;
  /** Folded, before the plural fold (what a prefix is compared with). */
  folded: string;
  /** The index term, or null for a word that is not kept. */
  term: string | null;
  start: number;
  end: number;
}

/** Every word of a text with its offsets. */
export function words(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    const folded = fold(m[0]);
    // A ligature or a compatibility form may fold to more than one word; keep the letters and digits.
    const clean = folded.replace(/[^\p{L}\p{N}]+/gu, '');
    if (!clean) continue;
    out.push({ raw: m[0], folded: clean, term: termOf(clean), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** The kept terms of a text in order (position = index). */
export function terms(text: string): string[] {
  return words(text)
    .map((w) => w.term)
    .filter((t): t is string => t != null);
}

/** The prefixes a term is reachable by for type-ahead: its first 2, 3 and 4 characters (by code point). */
export function prefixesOf(term: string): string[] {
  const cps = [...term];
  const out: string[] = [];
  for (let n = MIN_PREFIX; n <= Math.min(MAX_PREFIX, cps.length); n++) out.push(cps.slice(0, n).join(''));
  return out;
}

export type Unit = { kind: 'term'; term: string } | { kind: 'phrase'; terms: string[]; folded: string[] } | { kind: 'prefix'; prefix: string; folded: string };

export interface ParsedQuery {
  units: Unit[];
  /** Folded words of the query (stop words too), for marking matches in a snippet. */
  marks: { folded: string; prefix: boolean }[];
}

/**
 * Reads a query: bare words (all must match), "quoted phrases" (the words side by side), and `word*` (a prefix). With
 * `typeahead`, the last word, when nothing follows it, is a prefix too.
 */
export function parseQuery(q: string, o: { typeahead?: boolean } = {}): ParsedQuery {
  const units: Unit[] = [];
  const marks: ParsedQuery['marks'] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  const parts: { phrase: boolean; text: string; end: number }[] = [];
  for (const m of q.matchAll(re)) parts.push({ phrase: m[1] != null, text: m[1] ?? m[2]!, end: m.index! + m[0].length });
  const trailingSpace = /\s$/.test(q);
  parts.forEach((part, i) => {
    if (part.phrase) {
      const ws = words(part.text);
      const kept = ws.filter((w) => w.term).map((w) => w.term!);
      for (const w of ws) marks.push({ folded: w.folded, prefix: false });
      if (kept.length > 1) units.push({ kind: 'phrase', terms: kept, folded: ws.map((w) => w.folded) });
      else if (kept.length === 1) units.push({ kind: 'term', term: kept[0]! });
      return;
    }
    const star = part.text.endsWith('*');
    const ws = words(star ? part.text.slice(0, -1) : part.text);
    const last = i === parts.length - 1 && !trailingSpace;
    ws.forEach((w, j) => {
      const isPrefix = (star || (o.typeahead && last)) && j === ws.length - 1;
      if (isPrefix) {
        if ([...w.folded].length < MIN_PREFIX) return;
        marks.push({ folded: w.folded, prefix: true });
        units.push({ kind: 'prefix', prefix: [...w.folded].slice(0, MAX_PREFIX).join(''), folded: w.folded });
        return;
      }
      marks.push({ folded: w.folded, prefix: false });
      if (w.term) units.push({ kind: 'term', term: w.term });
    });
  });
  // The same term twice is one condition.
  const seen = new Set<string>();
  const unique = units.filter((u) => {
    const k = u.kind === 'term' ? `t:${u.term}` : u.kind === 'prefix' ? `p:${u.folded}` : `q:${u.folded.join(' ')}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { units: unique, marks };
}

/** Does an opened text satisfy the query exactly (phrases word for word, prefixes on the whole typed prefix)? */
export function matchesText(text: string, pq: ParsedQuery): boolean {
  const ws = words(text);
  for (const u of pq.units) {
    if (u.kind === 'term' && !ws.some((w) => w.term === u.term)) return false;
    if (u.kind === 'prefix' && !ws.some((w) => w.folded.startsWith(u.folded) || (w.term ?? '').startsWith(u.folded))) return false;
    if (u.kind === 'phrase') {
      const f = u.folded;
      let found = false;
      for (let i = 0; i + f.length <= ws.length && !found; i++) found = f.every((x, j) => ws[i + j]!.folded === x || (ws[i + j]!.term != null && ws[i + j]!.term === termOf(x)));
      if (!found) return false;
    }
  }
  return true;
}

/** Words of the text the query names, folded, for type-ahead completions (what the reader could have meant). */
export function completions(text: string, pq: ParsedQuery): string[] {
  const out: string[] = [];
  for (const m of pq.marks.filter((x) => x.prefix)) for (const w of words(text)) if (w.folded.startsWith(m.folded) && w.folded !== m.folded) out.push(w.raw.toLowerCase());
  return out;
}

export interface Snippet {
  text: string;
  /** [start, end) offsets of matched words inside `text`. */
  highlights: [number, number][];
}

const SNIPPET = 180;

/** A window of the text around its first match, with the matched words marked. */
export function snippet(text: string, pq: ParsedQuery, size = SNIPPET): Snippet {
  const flat = text.replace(/\s+/g, ' ').trim();
  const ws = words(flat);
  const hit = (w: Word) => pq.marks.some((m) => (m.prefix ? w.folded.startsWith(m.folded) : w.folded === m.folded || (w.term != null && w.term === termOf(m.folded))));
  const hits = ws.filter(hit);
  const first = hits[0];
  let from = 0;
  if (first && first.start > size / 3) from = Math.max(0, first.start - Math.floor(size / 3));
  if (from > 0) {
    const space = flat.lastIndexOf(' ', from);
    from = space > 0 && from - space < 20 ? space + 1 : from;
  }
  let to = Math.min(flat.length, from + size);
  if (to < flat.length) {
    const space = flat.indexOf(' ', to);
    to = space > 0 && space - to < 20 ? space : to;
  }
  const lead = from > 0 ? '…' : '';
  const tail = to < flat.length ? '…' : '';
  const out = lead + flat.slice(from, to) + tail;
  const highlights: [number, number][] = hits.filter((w) => w.start >= from && w.end <= to).map((w) => [w.start - from + lead.length, w.end - from + lead.length]);
  return { text: out, highlights };
}

const LINK = /\b(?:https?:\/\/|www\.)[^\s]+/i;
export const hasLink = (text: string): boolean => LINK.test(text);
