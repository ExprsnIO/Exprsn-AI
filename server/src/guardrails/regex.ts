import RE2 from 're2';

/**
 * Guardrail patterns are compiled with RE2 (the `re2` package, Google's RE2 behind a RegExp-like API), so matching
 * is linear in the input and a pattern cannot backtrack catastrophically. RE2 refuses what needs backtracking
 * (backreferences, lookahead and lookbehind); `compilePattern` reports where, and suggests an equivalent pattern when
 * a backreference only repeats a character class or an alternation.
 */
export interface PatternError {
  /** 1-based character position of the offending construct in the pattern. */
  pos: number;
  msg: string;
  /** An RE2-compatible rewrite, when one exists. */
  fix?: string;
}

export type Compiled = { ok: true; re: InstanceType<typeof RE2> } | { ok: false; error: PatternError };

const MAX_PATTERN = 2000;

export function compilePattern(pattern: string): Compiled {
  if (!pattern) return { ok: false, error: { pos: 1, msg: 'empty pattern' } };
  if (pattern.length > MAX_PATTERN) return { ok: false, error: { pos: MAX_PATTERN, msg: `pattern longer than ${MAX_PATTERN} characters` } };
  try {
    return { ok: true, re: new RE2(pattern, 'gu') };
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    // RE2 names the offending text after the colon: "invalid escape sequence: \2", "invalid perl operator: (?=".
    const what = msg.includes(': ') ? msg.slice(msg.indexOf(': ') + 2) : '';
    const at = what ? pattern.indexOf(what) : -1;
    const backref = /^invalid escape sequence: \\([1-9])/.exec(msg);
    const error: PatternError = {
      pos: at >= 0 ? at + 1 : 1,
      msg: backref ? `${msg} (backreferences are not supported by RE2)` : /perl operator: \(\?<?[=!]/.test(msg) ? `${msg} (lookaround is not supported by RE2)` : msg
    };
    if (backref) {
      const fix = withoutBackreference(pattern, Number(backref[1]));
      if (fix) error.fix = fix;
    }
    return { ok: false, error };
  }
}

/**
 * Replaces `\n` with a copy of group n when that group is a single character class (`(['"])`), and drops the
 * group's parentheses. It is the usual intent ("a quote, then later a quote") and is accepted by RE2, though it no
 * longer requires the two to be the same character.
 */
function withoutBackreference(pattern: string, n: number): string | null {
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '[') {
      const end = classEnd(pattern, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (ch !== '(' || pattern[i + 1] === '?') continue;
    count++;
    if (count !== n) continue;
    const close = groupEnd(pattern, i);
    if (close < 0) return null;
    const body = pattern.slice(i + 1, close);
    if (!/^\[[^\]]+\]$/.test(body) && !/^[^()|\\[\]]+(\|[^()|\\[\]]+)*$/.test(body)) return null;
    const replacement = body.startsWith('[') || !body.includes('|') ? body : `(?:${body})`;
    const rest = pattern.slice(close + 1).replace(new RegExp(`\\\\${n}(?![0-9])`), replacement);
    const out = pattern.slice(0, i) + replacement + rest;
    return compiles(out) ? out : null;
  }
  return null;
}

const compiles = (p: string) => {
  try {
    new RE2(p, 'u');
    return true;
  } catch {
    return false;
  }
};

function classEnd(p: string, start: number): number {
  for (let i = start + 1; i < p.length; i++) {
    if (p[i] === '\\') i++;
    else if (p[i] === ']' && i > start + 1) return i;
  }
  return -1;
}

function groupEnd(p: string, start: number): number {
  let depth = 0;
  for (let i = start; i < p.length; i++) {
    const ch = p[i];
    if (ch === '\\') i++;
    else if (ch === '[') {
      const e = classEnd(p, i);
      if (e < 0) return -1;
      i = e;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Every non-overlapping match as `[start, end)` offsets into `text` (at most `limit`). */
export function matchAll(re: InstanceType<typeof RE2>, text: string, limit = 1000): [number, number][] {
  const out: [number, number][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m && out.length < limit; m = re.exec(text)) {
    const end = m.index + m[0].length;
    out.push([m.index, end]);
    // An empty match would repeat forever; step past it.
    if (m[0].length === 0) re.lastIndex = end + 1;
  }
  re.lastIndex = 0;
  return out;
}

/** Escapes text so it matches literally (for rules created from a flagged span). */
export const escapeLiteral = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
