/*
 * B-156: the normaliser and matcher behind named term lists.
 *
 * Text and entries are reduced to the same skeleton before they are compared:
 *   - Unicode compatibility decomposition (NFKD), so full-width and other compatibility forms become their plain
 *     letters, and combining marks are dropped, so accents go ("café" is "cafe");
 *   - case folding;
 *   - a subset of the Unicode TR39 confusables: Cyrillic and Greek letters that look like Latin ones;
 *   - leetspeak: 4 and @ are a, 3 is e, 0 is o, 1 and l are i (one letter for both, so "1" matches "i" and "l"),
 *     5 and $ are s, 7 is t;
 *   - zero-width and other invisible format characters are removed, and runs of white space are one space;
 *   - letters split by spaces, dots, hyphens, underscores or asterisks ("s p a m", "s.p.a.m") are joined, in a second
 *     reading of the text: both readings are matched, so splitting a word neither hides it nor joins unrelated ones.
 *
 * Words and phrases are matched with one Aho-Corasick automaton per list version (linear in the text, whatever the
 * number of entries), by word boundary or as a substring; domains by walking a host's suffixes against a set. Every
 * match carries its span in the original text, so a redacting rule removes what the person wrote.
 */

export type TermMatch = 'word' | 'substring' | 'domain';
export interface TermEntry {
  value: string;
  match: TermMatch;
}

const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i', ј: 'j', һ: 'h', ԁ: 'd', ӏ: 'i', ԛ: 'q', ԝ: 'w', ь: 'b', ү: 'y', ҡ: 'k', ɡ: 'g',
  // Greek
  α: 'a', β: 'b', γ: 'y', δ: 'd', ε: 'e', ζ: 'z', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', σ: 'o', ς: 's', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // Latin lookalikes
  ı: 'i', ł: 'i', ø: 'o', đ: 'd', ħ: 'h', ŀ: 'i', ß: 'ss', æ: 'ae', œ: 'oe', 'ſ': 's'
};
const LEET: Record<string, string> = { '4': 'a', '@': 'a', '3': 'e', '0': 'o', '1': 'i', l: 'i', '5': 's', $: 's', '7': 't' };
/** Zero-width and invisible characters dropped before matching. */
const INVISIBLE_RANGES: [number, number][] = [[0xad, 0xad], [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0]];
const invisible = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return c >= 0xad && INVISIBLE_RANGES.some(([a, b]) => c >= a && c <= b);
};
const MARKS = /\p{M}/gu;
const SPACE = /\s/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** A normalised reading of a text, with each character's span in the original. */
export interface Reading {
  text: string;
  from: number[];
  to: number[];
}

function mapChar(ch: string): string {
  let s = ch;
  const code = ch.codePointAt(0)!;
  if (code > 0x7f) s = s.normalize('NFKD').replace(MARKS, '');
  s = s.toLowerCase();
  let out = '';
  for (const c of s) {
    const conf = CONFUSABLES[c] ?? c;
    for (const d of conf) out += LEET[d] ?? d;
  }
  return out;
}

/** The skeleton of a text: what entries are compared with. */
export function normalise(text: string): Reading {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const start = i;
    i += ch.length;
    if (invisible(ch)) continue;
    if (SPACE.test(ch)) {
      if (out.length && out[out.length - 1] === ' ') {
        to[to.length - 1] = i;
        continue;
      }
      out.push(' ');
      from.push(start);
      to.push(i);
      continue;
    }
    for (const c of mapChar(ch)) {
      out.push(c);
      from.push(start);
      to.push(i);
    }
  }
  return { text: out.join(''), from, to };
}

/** An entry's skeleton (trimmed, one space between words). */
export const normaliseEntry = (value: string): string => normalise(value.trim()).text.trim();

/** Separators that split a word into single letters: "s p a m", "s.p.a.m", "s-p-a-m", "s_p_a_m", "s*p*a*m". */
const SPLIT_RUN = /(?<![\p{L}\p{N}])[\p{L}\p{N}](?:[ .\-_*·•]{1,3}[\p{L}\p{N}](?![\p{L}\p{N}])){2,}/gu;

/** The second reading: single letters separated by spacing tricks joined into words. Null when there are none. */
export function joined(r: Reading): Reading | null {
  SPLIT_RUN.lastIndex = 0;
  let m = SPLIT_RUN.exec(r.text);
  if (!m) return null;
  const text: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let pos = 0;
  const copy = (a: number, b: number, keep: (c: string) => boolean) => {
    for (let k = a; k < b; k++) {
      const c = r.text[k]!;
      if (!keep(c)) continue;
      text.push(c);
      from.push(r.from[k]!);
      to.push(r.to[k]!);
    }
  };
  for (; m; m = SPLIT_RUN.exec(r.text)) {
    copy(pos, m.index, () => true);
    copy(m.index, m.index + m[0].length, (c) => ALNUM.test(c));
    pos = m.index + m[0].length;
  }
  copy(pos, r.text.length, () => true);
  return { text: text.join(''), from, to };
}

// ---------- the automaton ----------

/**
 * Aho-Corasick over UTF-16 code units. Transitions live in one Map keyed by `node * 65536 + code unit`, failure links
 * and output links in typed arrays; building is linear in the total length of the entries.
 */
class Automaton {
  private readonly next = new Map<number, number>();
  private fail: Int32Array = new Int32Array(1);
  /** The entry ending at a node (-1: none), and the nearest node on the failure chain that ends an entry. */
  private ends: number[] = [-1];
  private outLink: Int32Array = new Int32Array(1);
  private nodes = 1;

  constructor(patterns: string[]) {
    for (const [idx, p] of patterns.entries()) {
      let n = 0;
      for (let k = 0; k < p.length; k++) {
        const key = n * 65536 + p.charCodeAt(k);
        let c = this.next.get(key);
        if (c === undefined) {
          c = this.nodes++;
          this.next.set(key, c);
          this.ends.push(-1);
        }
        n = c;
      }
      if (this.ends[n] === -1) this.ends[n] = idx;
    }
    this.fail = new Int32Array(this.nodes);
    this.outLink = new Int32Array(this.nodes).fill(-1);
    // Children by node, for the breadth-first pass.
    const kids: [number, number][][] = Array.from({ length: this.nodes }, () => []);
    for (const [key, child] of this.next) kids[Math.floor(key / 65536)]!.push([key % 65536, child]);
    const queue: number[] = [];
    for (const [, c] of kids[0]!) {
      this.fail[c] = 0;
      queue.push(c);
    }
    for (let q = 0; q < queue.length; q++) {
      const n = queue[q]!;
      for (const [code, c] of kids[n]!) {
        let f = this.fail[n]!;
        while (f > 0 && !this.next.has(f * 65536 + code)) f = this.fail[f]!;
        const t = this.next.get(f * 65536 + code);
        this.fail[c] = t !== undefined && t !== c ? t : 0;
        const fc = this.fail[c]!;
        this.outLink[c] = this.ends[fc]! >= 0 ? fc : this.outLink[fc]!;
        queue.push(c);
      }
    }
  }

  /** Calls `hit(entry, end)` for every occurrence, `end` exclusive; stops when it returns false. */
  scan(text: string, hit: (entry: number, end: number) => boolean): void {
    let n = 0;
    for (let k = 0; k < text.length; k++) {
      const code = text.charCodeAt(k);
      let t = this.next.get(n * 65536 + code);
      while (t === undefined && n > 0) {
        n = this.fail[n]!;
        t = this.next.get(n * 65536 + code);
      }
      n = t ?? 0;
      for (let o = this.ends[n]! >= 0 ? n : this.outLink[n]!; o > 0; o = this.outLink[o]!) if (!hit(this.ends[o]!, k + 1)) return;
    }
  }

  get size(): number {
    return this.nodes;
  }
}

// ---------- a compiled list ----------

export interface TermHit {
  /** The entry as written in the list. */
  entry: string;
  match: TermMatch;
  /** Offsets in the original text, end exclusive. */
  span: [number, number];
}

const HOST = /(?:https?:\/\/)?((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}]{2,63})(?![\p{L}\p{N}-])/giu;
const MAX_HITS = 200;

/** A host as compared with domain entries: lower case and with lookalike letters folded, no trailing dot. */
export const hostSkeleton = (host: string): string => [...host.toLowerCase().replace(/\.$/, '')].map((c) => (c === '.' || c === '-' ? c : mapChar(c))).join('');

/** One list version, compiled. */
export class CompiledTerms {
  private readonly automaton: Automaton | null;
  private readonly phrases: { entry: TermEntry; skeleton: string }[] = [];
  private readonly domains = new Map<string, string>();
  readonly entries: number;

  constructor(entries: TermEntry[]) {
    this.entries = entries.length;
    const seen = new Set<string>();
    for (const e of entries) {
      if (e.match === 'domain') {
        this.domains.set(hostSkeleton(e.value.replace(/^\*\./, '')), e.value);
        continue;
      }
      const skeleton = normaliseEntry(e.value);
      if (!skeleton || seen.has(`${e.match}:${skeleton}`)) continue;
      seen.add(`${e.match}:${skeleton}`);
      this.phrases.push({ entry: e, skeleton });
    }
    this.automaton = this.phrases.length ? new Automaton(this.phrases.map((p) => p.skeleton)) : null;
  }

  get hasDomains(): boolean {
    return this.domains.size > 0;
  }

  /** The domain entry a host falls under (itself or a parent domain), or null. */
  domainOf(host: string): string | null {
    let h = hostSkeleton(host);
    for (;;) {
      const hit = this.domains.get(h);
      if (hit !== undefined) return hit;
      const dot = h.indexOf('.');
      if (dot < 0) return null;
      h = h.slice(dot + 1);
    }
  }

  /** Every word, phrase and domain entry found in a text. */
  find(text: string, limit = MAX_HITS): TermHit[] {
    const out: TermHit[] = [];
    const seen = new Set<string>();
    const push = (h: TermHit) => {
      const k = `${h.span[0]}:${h.span[1]}:${h.entry}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(h);
    };
    if (this.automaton) {
      const first = normalise(text);
      const readings = [first, joined(first)].filter((r): r is Reading => !!r);
      for (const r of readings) {
        this.automaton.scan(r.text, (idx, end) => {
          const p = this.phrases[idx]!;
          const start = end - p.skeleton.length;
          if (p.entry.match === 'word' && ((start > 0 && ALNUM.test(r.text[start - 1]!)) || (end < r.text.length && ALNUM.test(r.text[end]!)))) return true;
          push({ entry: p.entry.value, match: p.entry.match, span: [r.from[start]!, r.to[end - 1]!] });
          return out.length < limit;
        });
        if (out.length >= limit) break;
      }
    }
    if (this.domains.size && out.length < limit) {
      for (const h of hostsIn(text)) {
        const d = this.domainOf(h.host);
        if (d !== null) push({ entry: d, match: 'domain', span: h.span });
        if (out.length >= limit) break;
      }
    }
    return out.sort((a, b) => a.span[0] - b.span[0]);
  }
}

/** Hosts written in a text, as links or bare domain names, with their spans. */
export function hostsIn(text: string): { host: string; span: [number, number] }[] {
  const out: { host: string; span: [number, number] }[] = [];
  let clean = '';
  for (const ch of text) clean += invisible(ch) ? ' '.repeat(ch.length) : ch;
  HOST.lastIndex = 0;
  for (let m = HOST.exec(clean); m && out.length < 1000; m = HOST.exec(clean)) {
    const start = m.index + m[0].length - m[1]!.length;
    out.push({ host: m[1]!, span: [start, start + m[1]!.length] });
  }
  return out;
}
