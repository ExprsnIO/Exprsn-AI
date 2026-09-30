import type { AuditInput, AuditLog } from './chain.js';

/**
 * Authorisation denials go to the audit chain, but a principal hammering a forbidden route must not be able to grow
 * the chain (one serialised transaction per entry) without bound. Each principal gets `perWindow` full entries per
 * window; further denials in that window are counted and written as one `authz.denied.suppressed` summary when the
 * window ends, with the count per action. Counts are per server instance, so the bound is per instance.
 */
export class DenialAudit {
  private readonly windows = new Map<string, { tenantId: string; actor: AuditInput['actor']; started: number; written: number; suppressed: Map<string, number>; timer: NodeJS.Timeout | null }>();

  constructor(
    private readonly audit: AuditLog,
    private readonly perWindow = 20,
    private readonly windowMs = 60_000
  ) {}

  async record(key: string, input: AuditInput & { target?: { method?: string; path?: string } }): Promise<void> {
    const now = Date.now();
    let w = this.windows.get(key);
    if (w && now - w.started >= this.windowMs) {
      await this.flush(key);
      w = undefined;
    }
    if (!w) {
      w = { tenantId: input.tenantId, actor: input.actor, started: now, written: 0, suppressed: new Map(), timer: null };
      this.windows.set(key, w);
    }
    if (w.written < this.perWindow) {
      w.written++;
      await this.audit.append(input);
      return;
    }
    const what = `${input.target?.method ?? '?'} ${input.target?.path ?? '?'}`;
    w.suppressed.set(what, (w.suppressed.get(what) ?? 0) + 1);
    if (!w.timer) {
      w.timer = setTimeout(() => void this.flush(key).catch(() => undefined), Math.max(0, w.started + this.windowMs - now));
      w.timer.unref();
    }
  }

  /** Writes the window's summary (if anything was suppressed) and closes it. */
  async flush(key: string): Promise<void> {
    const w = this.windows.get(key);
    if (!w) return;
    this.windows.delete(key);
    if (w.timer) clearTimeout(w.timer);
    if (!w.suppressed.size) return;
    const total = [...w.suppressed.values()].reduce((a, b) => a + b, 0);
    await this.audit.append({
      tenantId: w.tenantId,
      action: 'authz.denied.suppressed',
      kind: 'decision',
      actor: w.actor,
      detail: { count: total, since: w.started, until: Date.now(), byRoute: Object.fromEntries(w.suppressed), note: `After ${this.perWindow} denials in a window, further ones are counted here instead of written one by one.` }
    });
  }

  async flushAll(): Promise<void> {
    for (const key of [...this.windows.keys()]) await this.flush(key);
  }
}
