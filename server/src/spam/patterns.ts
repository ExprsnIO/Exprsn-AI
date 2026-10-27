import { createHash } from 'node:crypto';

/*
 * 1.9.0, Sprint 50 (B-160): the pure half of the spam pattern detectors. Everything here works on a text in memory
 * and returns hashes and counts; nothing keeps the text.
 *
 * - SimHash: 64 bits over word 1- to 3-shingles (character 4-grams for texts of fewer than five words), each shingle
 *   hashed with two FNV-1a variants into a high and a low 32-bit half. Two texts are near-duplicates when the Hamming
 *   distance of their fingerprints is at most the threshold (12 by default: short posts move more bits per changed
 *   word than long documents). The fingerprint is also split into four 16-bit bands: within 3 bits two fingerprints
 *   share a band, so with a threshold of 3 or less candidates are found by band; above it the recent fingerprints
 *   of the window are compared bit by bit.
 * - Links, domains, mentions and hashtags: counted from the text; domains are kept (they are not content), the rest
 *   only as counts.
 */

export interface Fingerprint {
  /** 16 hex digits. */
  hex: string;
  hi: number;
  lo: number;
  bands: [number, number, number, number];
}

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(s: string, seed: number): number {
  let h = (FNV_OFFSET ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  // A final avalanche, so shingles that differ in their last character spread over every bit.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Lower case, accents folded, links reduced to their domain, punctuation to spaces. */
export function normalise(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/([^\s/?#]+)[^\s]*/g, ' $1 ')
    .replace(/[^\p{L}\p{N}@#.]+/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

function shingles(words: string[]): string[] {
  if (words.length >= 5) {
    // Words, pairs and triples: one changed word moves a small share of the features, so near-duplicates stay close.
    const out: string[] = [];
    for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= words.length; i++) out.push(`${n}:${words.slice(i, i + n).join(' ')}`);
    return out;
  }
  const joined = words.join(' ');
  const out: string[] = [];
  for (let i = 0; i + 4 <= joined.length; i++) out.push(joined.slice(i, i + 4));
  return out;
}

/** The SimHash of a text; null when it is too short to say anything (fewer than three shingles). */
export function simhash(text: string): Fingerprint | null {
  const sh = shingles(normalise(text));
  if (sh.length < 3) return null;
  const v = new Int32Array(64);
  for (const s of sh) {
    const hi = fnv1a(s, 0);
    const lo = fnv1a(s, 0x9e3779b9);
    for (let b = 0; b < 32; b++) {
      v[b]! += (hi >>> b) & 1 ? 1 : -1;
      v[32 + b]! += (lo >>> b) & 1 ? 1 : -1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b]! > 0) hi |= 1 << b;
    if (v[32 + b]! > 0) lo |= 1 << b;
  }
  return fingerprintOf(hi >>> 0, lo >>> 0);
}

export function fingerprintOf(hi: number, lo: number): Fingerprint {
  const hex = hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
  return { hex, hi, lo, bands: [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff] };
}

export function parseFingerprint(hex: string): Fingerprint {
  return fingerprintOf(parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8, 16), 16) >>> 0);
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24) & 0xff;
}

export function hamming(a: Fingerprint, b: Fingerprint): number {
  return popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
}

/** A 64-bit hash (16 hex digits) of an identifier, so where something went is kept without the identifier itself. */
export function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The domains of the links in a text: http(s) URLs and `www.` hosts, lower case, without a port or `www.`. */
export function linkDomains(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:https?:\/\/([^\s/?#<>"']+)|www\.([a-z0-9][a-z0-9.-]*\.[a-z]{2,}))/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let host = (m[1] ?? `www.${m[2]}`).toLowerCase();
    host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.+$/, '');
    if (/^[a-z0-9.-]{1,253}$/.test(host) && host.includes('.')) out.push(host);
    if (out.length >= 200) break;
  }
  return out;
}

export function mentionCount(text: string): number {
  return (text.match(/(?:^|[\s(])@[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}/gu) ?? []).length;
}

export function hashtagCount(text: string): number {
  return (text.match(/(?:^|[\s(])#[\p{L}\p{N}_]{1,64}/gu) ?? []).length;
}

/** What one text contributes to the detectors: hashes and counts only. */
export interface TextFeatures {
  fingerprint: Fingerprint | null;
  links: number;
  domains: string[];
  mentions: number;
  hashtags: number;
  length: number;
}

export function features(text: string | null | undefined): TextFeatures | null {
  if (!text) return null;
  const domains = linkDomains(text);
  return { fingerprint: simhash(text), links: domains.length, domains: [...new Set(domains)].slice(0, 50), mentions: mentionCount(text), hashtags: hashtagCount(text), length: text.length };
}

/** A score after `elapsedMs` of decay with the given half-life. */
export function decayed(score: number, elapsedMs: number, halfLifeMs: number): number {
  if (score <= 0) return 0;
  if (elapsedMs <= 0 || halfLifeMs <= 0) return score;
  return score * Math.pow(0.5, elapsedMs / halfLifeMs);
}
