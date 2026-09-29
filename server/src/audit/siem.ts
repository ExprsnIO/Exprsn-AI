import type { Logger } from 'pino';
import type { AuditEvent, AuditLog } from './chain.js';

export interface SiemStatus {
  enabled: boolean;
  url: string | null;
  state: 'connected' | 'failing' | 'idle' | 'disabled';
  delivered: number;
  pending: number;
  dropped: number;
  lastDeliveredAt: number | null;
  lastError: string | null;
}

/**
 * Streams audit events to a SIEM as they are appended: NDJSON batches POSTed to SIEM_URL (Splunk HEC, Elastic,
 * Vector, Fluent Bit and Logstash HTTP inputs all accept this), with a bearer token if set. Delivery is at least
 * once from this instance with backoff; events that overflow the buffer are counted as dropped, and the chain in
 * the database stays the record of truth (a SIEM can re-read it by sequence number).
 */
export class SiemForwarder {
  private buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private backoff = 1000;
  private sending = false;
  private readonly status: SiemStatus;
  private readonly off: () => void;

  constructor(
    audit: AuditLog,
    private readonly log: Logger,
    private readonly o: { url?: string; token?: string; batch?: number; maxBuffer?: number; send?: (body: string) => Promise<void> }
  ) {
    this.status = { enabled: !!o.url || !!o.send, url: o.url ? new URL(o.url).origin : null, state: o.url || o.send ? 'idle' : 'disabled', delivered: 0, pending: 0, dropped: 0, lastDeliveredAt: null, lastError: null };
    this.off = this.status.enabled ? audit.onAppend((e) => this.push(e)) : () => undefined;
  }

  view(): SiemStatus {
    return { ...this.status, pending: this.buffer.length };
  }

  private push(e: AuditEvent): void {
    this.buffer.push(e);
    const max = this.o.maxBuffer ?? 10_000;
    if (this.buffer.length > max) {
      this.status.dropped += this.buffer.length - max;
      this.buffer.splice(0, this.buffer.length - max);
    }
    this.schedule(200);
  }

  private schedule(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
    this.timer.unref();
  }

  private async post(body: string): Promise<void> {
    if (this.o.send) return this.o.send(body);
    const res = await fetch(this.o.url as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', ...(this.o.token ? { Authorization: `Bearer ${this.o.token}` } : {}) },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`SIEM answered ${res.status}`);
  }

  async flush(): Promise<void> {
    if (this.sending || !this.buffer.length) return;
    this.sending = true;
    const batch = this.buffer.slice(0, this.o.batch ?? 500);
    try {
      await this.post(batch.map((e) => JSON.stringify({ source: 'exprsn-ai', ...e })).join('\n') + '\n');
      this.buffer.splice(0, batch.length);
      Object.assign(this.status, { state: 'connected', delivered: this.status.delivered + batch.length, lastDeliveredAt: Date.now(), lastError: null });
      this.backoff = 1000;
      if (this.buffer.length) this.schedule(0);
    } catch (err) {
      Object.assign(this.status, { state: 'failing', lastError: (err as Error).message });
      this.log.warn({ err: (err as Error).message, pending: this.buffer.length }, 'SIEM delivery failed');
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.schedule(this.backoff);
    } finally {
      this.sending = false;
    }
  }

  close(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
  }
}
