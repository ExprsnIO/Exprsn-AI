import type { GuardDecision, GuardFinding } from './types.js';

/**
 * Screened-prefix streaming (ported from exprsn-platform's cortex `streamGuard`). Model output is not sent token by
 * token: deltas are buffered until a sentence end or line break (or `MAX_HOLD_CHARS` without one), then the whole
 * buffer so far is screened by the fast deterministic rules of the `model-output` checkpoint, and only the part that
 * passed is released. Screening the whole buffer, not the new slice, catches a phrase split across deltas.
 *
 * - `block` halts: nothing more is released and the caller stops the generation.
 * - `require-approval` holds: nothing more is released; the caller lets the answer finish so a reviewer sees it whole.
 * - `redact` releases the new text with the flagged spans replaced.
 * - anything else releases the new text as it is.
 *
 * The guard model and classifiers are not run here (a model call per sentence would cost more than streaming saves);
 * the full check still runs once on the finished answer and can replace what was released.
 */
export const MAX_HOLD_CHARS = 240;

// A sentence end followed by whitespace (so "3.14" and "e.g.x" do not count), or a line break. Built per scan: a
// shared `/g` regex carries `lastIndex` between streams.
const BOUNDARY = '([.!?…]["\'’”)\\]]?(?=\\s)|\\n)';

/** Index just past the last releasable boundary at or after `from`, or -1 while a short tail holds no boundary. */
export function lastBoundaryEnd(text: string, from: number, maxHold = MAX_HOLD_CHARS): number {
  const re = new RegExp(BOUNDARY, 'g');
  re.lastIndex = from;
  let end = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) end = m.index + m[0].length;
  if (end === -1) return text.length - from >= maxHold ? text.length : -1;
  // The whitespace after the terminator goes with the sentence it ends.
  while (end < text.length && /\s/.test(text[end]!)) end++;
  return end;
}

export type Screen = (text: string) => GuardDecision | Promise<GuardDecision>;

export interface Release {
  /** Newly released text (screened, redacted where a rule said so). */
  text: string;
  halted: boolean;
  held: boolean;
  decision: GuardDecision | null;
}

export class StreamGuard {
  private buf = '';
  private releasedTo = 0;
  private out = '';
  private haltDecision: GuardDecision | null = null;
  private holdDecision: GuardDecision | null = null;

  constructor(
    private readonly screen: Screen,
    private readonly maxHold = MAX_HOLD_CHARS
  ) {}

  /** Text already shown before this guard started (a continued answer): screened then, released now. */
  preload(text: string): void {
    this.buf = text;
    this.releasedTo = text.length;
    this.out = text;
  }

  get halted(): GuardDecision | null {
    return this.haltDecision;
  }

  get held(): GuardDecision | null {
    return this.holdDecision;
  }

  /** Everything accumulated, released or not. */
  get buffered(): string {
    return this.buf;
  }

  /** Everything released so far, as it was released. */
  get released(): string {
    return this.out;
  }

  private stopped(): Release | null {
    if (this.haltDecision) return { text: '', halted: true, held: false, decision: this.haltDecision };
    if (this.holdDecision) return { text: '', halted: false, held: true, decision: this.holdDecision };
    return null;
  }

  async push(delta: string): Promise<Release> {
    const s = this.stopped();
    if (s) {
      this.buf += delta;
      return s;
    }
    if (!delta) return { text: '', halted: false, held: false, decision: null };
    this.buf += delta;
    const end = lastBoundaryEnd(this.buf, this.releasedTo, this.maxHold);
    if (end === -1) return { text: '', halted: false, held: false, decision: null };
    return this.screenAndRelease(end);
  }

  /** Screens and releases the rest (the answer ended). */
  finish(): Promise<Release> {
    return this.screenAndRelease(this.buf.length);
  }

  private async screenAndRelease(upTo: number): Promise<Release> {
    const s = this.stopped();
    if (s) return s;
    if (upTo <= this.releasedTo) return { text: '', halted: false, held: false, decision: null };
    const d = await this.screen(this.buf.slice(0, upTo));
    if (d.action === 'block') {
      this.haltDecision = d;
      return { text: '', halted: true, held: false, decision: d };
    }
    if (d.action === 'require-approval') {
      this.holdDecision = d;
      return { text: '', halted: false, held: true, decision: d };
    }
    const text = d.action === 'redact' ? redactSlice(this.buf, this.releasedTo, upTo, d.findings) : this.buf.slice(this.releasedTo, upTo);
    this.releasedTo = upTo;
    this.out += text;
    return { text, halted: false, held: false, decision: d };
  }
}

/** The slice [from, to) with the enforced redaction spans that fall in it replaced; a spanless redaction hides the slice. */
function redactSlice(text: string, from: number, to: number, findings: GuardFinding[]): string {
  const red = findings.filter((f) => f.stage === 'enforce' && f.action === 'redact');
  if (red.some((f) => !f.span)) return '[redacted]';
  const spans = red
    .map((f) => [Math.max(from, f.span![0]), Math.min(to, f.span![1])] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = from;
  for (const [s, e] of spans) {
    if (e <= pos) continue;
    out += `${text.slice(pos, Math.max(pos, s))}[redacted]`;
    pos = e;
  }
  return out + text.slice(pos, to);
}
