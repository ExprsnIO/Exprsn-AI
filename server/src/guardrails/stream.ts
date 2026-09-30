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
 * Sprint 16 (B-703): with a model screen (the enforced guard-model and classifier rules), each window the
 * deterministic rules passed is also checked by the model screen in the background, over the whole text so far. Checks
 * never block the event loop: they are promises, at most one in flight per stream (a newer check covers every window
 * screened since), and at most `CheckLimiter.max` per instance. With a hold-back of N ≥ 1 a screened window is
 * released only once a clean verdict covers it; up to N windows may wait for that while generation goes on, and the
 * next one waits for the verdict in flight (so a verdict always lands before more text is released). With N = 0 a
 * window is released at once and a verdict can only stop what follows. An unsafe verdict halts or holds like the
 * deterministic rules; a check that fails stops further release (what is left goes out after the full check).
 * The full check still runs once on the finished answer and can replace what was released.
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

/**
 * Bounds the background checks one instance runs at once. Waiting callers queue in order; nothing spins or blocks.
 */
export class CheckLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Checks started and the most in flight at once (for the load test and metrics). */
  readonly stats = { started: 0, peak: 0, queuedPeak: 0 };

  constructor(readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        this.stats.queuedPeak = Math.max(this.stats.queuedPeak, this.waiting.length);
      });
    }
    this.active++;
    this.stats.started++;
    this.stats.peak = Math.max(this.stats.peak, this.active);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}

export interface ModelScreen {
  /** The guard-model and classifier rules over the text so far. */
  screen: Screen;
  /** Screened windows that may wait for a verdict before `push` waits too (0: release at once). */
  holdback: number;
  limiter: CheckLimiter;
  /** Releases (and halts or holds) decided by a verdict that arrived outside `push`. */
  onRelease: (r: Release) => void;
}

interface Window {
  from: number;
  to: number;
  /** Enforced redactions of the deterministic screen that fall in the window. */
  findings: GuardFinding[];
}

export interface Release {
  /** Newly released text (screened, redacted where a rule said so). */
  text: string;
  halted: boolean;
  held: boolean;
  decision: GuardDecision | null;
}

export class StreamGuard {
  private buf = '';
  /** How far the deterministic screen has passed the buffer. */
  private releasedTo = 0;
  /** How far the buffer has been released (equal to `releasedTo` without a model screen). */
  private shownTo = 0;
  private out = '';
  private haltDecision: GuardDecision | null = null;
  private holdDecision: GuardDecision | null = null;
  private readonly queue: Window[] = [];
  private checkedTo = 0;
  private inflight: Promise<void> | null = null;
  private failed = false;
  private closed = false;

  constructor(
    private readonly screen: Screen,
    private readonly maxHold = MAX_HOLD_CHARS,
    private readonly model: ModelScreen | null = null
  ) {}

  /** Text already shown before this guard started (a continued answer): screened then, released now. */
  preload(text: string): void {
    this.buf = text;
    this.releasedTo = text.length;
    this.shownTo = text.length;
    this.checkedTo = text.length;
    this.out = text;
  }

  /**
   * What the deterministic screen passed but no verdict released yet (and the tail after a failed check), once the
   * stream is finished. The caller releases it after the full check on the finished answer has passed it.
   */
  get unreleased(): string {
    return this.haltDecision || this.holdDecision ? '' : this.buf.slice(this.shownTo, this.releasedTo);
  }

  /** No verdict releases anything any more (the stream ended some other way). */
  close(): void {
    this.closed = true;
  }

  /** Marks the unreleased text as released by the caller. */
  markReleased(): void {
    this.out += this.buf.slice(this.shownTo, this.releasedTo);
    this.shownTo = this.releasedTo;
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

  /**
   * Screens the rest (the answer ended). With a model screen, no later verdict releases anything: what is still
   * waiting is `unreleased`, for the caller to release once the full check has passed the answer.
   */
  async finish(): Promise<Release> {
    const r = await this.screenAndRelease(this.buf.length, true);
    this.closed = true;
    return r;
  }

  private async screenAndRelease(upTo: number, last = false): Promise<Release> {
    const s = this.stopped();
    if (s) return s;
    if (upTo <= this.releasedTo) return { text: '', halted: false, held: false, decision: null };
    const d = await this.screen(this.buf.slice(0, upTo));
    if (d.action === 'block') {
      this.haltDecision = d;
      this.queue.length = 0;
      return { text: '', halted: true, held: false, decision: d };
    }
    if (d.action === 'require-approval') {
      this.holdDecision = d;
      this.queue.length = 0;
      return { text: '', halted: false, held: true, decision: d };
    }
    const w: Window = { from: this.releasedTo, to: upTo, findings: d.action === 'redact' ? d.findings : [] };
    this.releasedTo = upTo;
    const m = this.model;
    if (!m || (m.holdback === 0 && !this.failed)) {
      const text = this.show(w, []);
      if (m) this.kick();
      return { text, halted: false, held: false, decision: d };
    }
    if (this.failed) return { text: '', halted: false, held: false, decision: d };
    this.queue.push(w);
    // The last window is not checked here: the full check on the finished answer decides it.
    if (last) return { text: '', halted: false, held: false, decision: d };
    this.kick();
    // Back-pressure: more than N windows waiting means the next one waits for the verdict in flight.
    while (this.queue.length > m.holdback && !this.stopped() && !this.failed && this.inflight) await this.inflight;
    return this.stopped() ?? { text: '', halted: false, held: false, decision: d };
  }

  /** Releases a window (with its redactions and a verdict's). */
  private show(w: Window, extra: GuardFinding[]): string {
    const findings = [...w.findings, ...extra.filter((f) => f.stage === 'enforce' && f.action === 'redact')];
    const text = findings.length ? redactSlice(this.buf, w.from, w.to, findings) : this.buf.slice(w.from, w.to);
    this.shownTo = w.to;
    this.out += text;
    return text;
  }

  /** Starts a background check over everything screened so far, unless one is in flight (it will start the next). */
  private kick(): void {
    const m = this.model;
    if (!m || this.inflight || this.closed || this.failed || this.stopped()) return;
    const upTo = this.releasedTo;
    if (upTo <= this.checkedTo) return;
    const text = this.buf.slice(0, upTo);
    this.inflight = m.limiter
      .run(async () => m.screen(text))
      .then(
        (d) => this.verdict(upTo, d),
        () => {
          // The check could not run: nothing more is released until the full check has passed the answer.
          this.failed = true;
        }
      )
      .finally(() => {
        this.inflight = null;
        this.kick();
      });
  }

  private verdict(upTo: number, d: GuardDecision): void {
    if (this.closed || this.stopped()) return;
    const m = this.model!;
    if (d.action === 'block' || d.action === 'require-approval') {
      if (d.action === 'block') this.haltDecision = d;
      else this.holdDecision = d;
      this.queue.length = 0;
      m.onRelease({ text: '', halted: d.action === 'block', held: d.action === 'require-approval', decision: d });
      return;
    }
    this.checkedTo = upTo;
    let text = '';
    while (this.queue.length && this.queue[0]!.to <= upTo) text += this.show(this.queue.shift()!, d.action === 'redact' ? d.findings : []);
    if (text) m.onRelease({ text, halted: false, held: false, decision: d });
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
