/*
 * The image-safety classifier, used on generated images and on frames sampled from video before they reach a vision
 * model. The HTTP adapter posts the picture to a classifier service and reads `{score, categories}` (score 0–1, higher
 * is less safe). Without one configured, pictures are marked as not classified rather than silently passed.
 */

export interface SafetyVerdict {
  score: number;
  categories: Record<string, number>;
  classifier: string;
}

export interface ImageSafety {
  readonly name: string;
  /** null when no classifier is configured. */
  classify(image: Buffer, type: string, signal?: AbortSignal): Promise<SafetyVerdict | null>;
}

export const noSafety: ImageSafety = { name: 'none', classify: async () => null };

export class HttpSafety implements ImageSafety {
  readonly name: string;

  constructor(private readonly url: string) {
    this.name = `http ${new URL(url).host}`;
  }

  async classify(image: Buffer, type: string, signal?: AbortSignal): Promise<SafetyVerdict> {
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': type, accept: 'application/json' }, body: new Uint8Array(image), signal: signal ?? AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`The safety classifier answered ${res.status}`);
    const j = (await res.json()) as { score?: unknown; categories?: Record<string, unknown> };
    const score = Number(j.score);
    if (!Number.isFinite(score)) throw new Error('The safety classifier gave no score');
    return { score: Math.max(0, Math.min(1, score)), categories: Object.fromEntries(Object.entries(j.categories ?? {}).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v))), classifier: this.name };
  }
}
