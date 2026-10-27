/*
 * Differentials of crawled pages: what a page's text gained and lost between two crawls, as a line diff of the
 * extracted text (so markup that changes on every request, such as tokens and timestamps in attributes, is no
 * change). The common start and end are set aside, the middle is compared by longest common subsequence up to a
 * size, and past it the middle counts as replaced whole.
 */

export interface TextDiff {
  added: number;
  removed: number;
  /** Hunks in the unified format (`@@ -a,b +c,d @@`, then ` `, `-` and `+` lines), at most `maxChars` long. */
  text: string;
  truncated: boolean;
}

export interface DiffOptions {
  /** Unchanged lines shown around a change. */
  context: number;
  maxChars: number;
  /** The most cells the comparison table may have; larger middles count as replaced whole. */
  maxCells: number;
}

export const DIFF_DEFAULTS: DiffOptions = { context: 2, maxChars: 64_000, maxCells: 4_000_000 };

type Op = { kind: ' ' | '-' | '+'; line: string };

const lines = (s: string): string[] => (s ? s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()) : []);

function middle(a: string[], b: string[], maxCells: number): Op[] {
  if (!a.length) return b.map((line) => ({ kind: '+' as const, line }));
  if (!b.length) return a.map((line) => ({ kind: '-' as const, line }));
  if (a.length * b.length > maxCells) return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
  const w = b.length + 1;
  const t = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i]! });
      i++;
      j++;
    } else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) out.push({ kind: '-', line: a[i++]! });
    else out.push({ kind: '+', line: b[j++]! });
  }
  while (i < a.length) out.push({ kind: '-', line: a[i++]! });
  while (j < b.length) out.push({ kind: '+', line: b[j++]! });
  return out;
}

/** The line diff of two texts. `added` and `removed` count lines of text, not blank lines. */
export function textDiff(before: string, after: string, opts: Partial<DiffOptions> = {}): TextDiff {
  const o = { ...DIFF_DEFAULTS, ...opts };
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: Op[] = [...a.slice(0, head).map((line) => ({ kind: ' ' as const, line })), ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail), o.maxCells), ...a.slice(a.length - tail).map((line) => ({ kind: ' ' as const, line }))];
  // Lines of text are counted; a paragraph break that came or went is shown in the hunks but is no change of its own.
  const added = ops.filter((x) => x.kind === '+' && x.line.trim()).length;
  const removed = ops.filter((x) => x.kind === '-' && x.line.trim()).length;
  if (!added && !removed) return { added: 0, removed: 0, text: '', truncated: false };

  // Hunks: each change with its context; changes whose contexts touch share one.
  const keep = new Uint8Array(ops.length);
  ops.forEach((x, n) => {
    if (x.kind === ' ') return;
    for (let k = Math.max(0, n - o.context); k <= Math.min(ops.length - 1, n + o.context); k++) keep[k] = 1;
  });
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  let la = 1;
  let lb = 1;
  for (let n = 0; n < ops.length && !truncated; ) {
    if (!keep[n]) {
      la++;
      lb++;
      n++;
      continue;
    }
    let end = n;
    while (end < ops.length && keep[end]) end++;
    const hunk = ops.slice(n, end);
    const na = hunk.filter((x) => x.kind !== '+').length;
    const nb = hunk.filter((x) => x.kind !== '-').length;
    for (const l of [`@@ -${la},${na} +${lb},${nb} @@`, ...hunk.map((x) => `${x.kind}${x.line}`)]) {
      if (size + l.length + 1 > o.maxChars) {
        truncated = true;
        break;
      }
      out.push(l);
      size += l.length + 1;
    }
    la += na;
    lb += nb;
    n = end;
  }
  return { added, removed, text: out.join('\n'), truncated };
}
