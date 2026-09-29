import { createHash } from 'node:crypto';

/**
 * The trained classifier engine: hashed word and word-pair features with a one-vs-rest logistic head per label,
 * trained by stochastic gradient descent on a tenant's labelled cases. Small (a few thousand weights per label), fast
 * (well under a millisecond per text) and deterministic for a given training set.
 */
export const DIMS = 2048;

export interface LinearHead {
  dims: number;
  /** Per label: bias and weights. */
  labels: Record<string, { b: number; w: number[] }>;
  trainedAt: number;
  samples: number;
}

const bucket = (token: string): number => createHash('md5').update(token).digest().readUInt32LE(0) % DIMS;

/** Sparse, L2-normalised feature vector: log-scaled counts of words and adjacent word pairs. */
export function features(text: string): Map<number, number> {
  const words = text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) ?? [];
  const counts = new Map<number, number>();
  const add = (t: string) => {
    const i = bucket(t);
    counts.set(i, (counts.get(i) ?? 0) + 1);
  };
  for (let i = 0; i < words.length && i < 5000; i++) {
    add(words[i]!);
    if (i > 0) add(`${words[i - 1]} ${words[i]}`);
  }
  let norm = 0;
  for (const [k, v] of counts) {
    const x = 1 + Math.log(v);
    counts.set(k, x);
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [k, v] of counts) counts.set(k, v / norm);
  return counts;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function scoreLinear(head: LinearHead, text: string): Record<string, number> {
  const x = features(text);
  const out: Record<string, number> = {};
  for (const [label, { b, w }] of Object.entries(head.labels)) {
    let z = b;
    for (const [i, v] of x) z += (w[i] ?? 0) * v;
    out[label] = Math.round(sigmoid(z) * 1000) / 1000;
  }
  return out;
}

/** Trains one logistic head per label (that label against the rest). Deterministic: a fixed shuffle order. */
export function trainLinear(samples: { text: string; expected: string }[], labels: string[], opts: { epochs?: number; rate?: number; l2?: number } = {}): LinearHead {
  const epochs = opts.epochs ?? 40;
  const rate = opts.rate ?? 0.5;
  const l2 = opts.l2 ?? 1e-4;
  const xs = samples.map((s) => ({ x: features(s.text), y: s.expected }));
  const order = xs.map((_, i) => i).sort((a, b) => bucket(`o${a}`) - bucket(`o${b}`) || a - b);
  const head: LinearHead = { dims: DIMS, labels: {}, trainedAt: Date.now(), samples: samples.length };
  for (const label of labels) {
    const w = new Array<number>(DIMS).fill(0);
    let b = 0;
    const pos = xs.filter((s) => s.y === label).length;
    // Weight the rarer class up so a small label is not drowned by the rest.
    const wPos = pos ? xs.length / (2 * pos) : 1;
    const wNeg = xs.length - pos ? xs.length / (2 * (xs.length - pos)) : 1;
    for (let e = 0; e < epochs; e++) {
      const lr = rate / (1 + e * 0.1);
      for (const i of order) {
        const s = xs[i]!;
        const y = s.y === label ? 1 : 0;
        let z = b;
        for (const [k, v] of s.x) z += w[k]! * v;
        const g = (sigmoid(z) - y) * (y ? wPos : wNeg);
        b -= lr * g;
        for (const [k, v] of s.x) w[k] = w[k]! - lr * (g * v + l2 * w[k]!);
      }
    }
    head.labels[label] = { b: round(b), w: w.map(round) };
  }
  return head;
}

const round = (v: number) => Math.round(v * 10_000) / 10_000;
