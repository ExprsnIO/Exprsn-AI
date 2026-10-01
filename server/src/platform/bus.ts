import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';

const CHANNEL = 'exprsn:bus';

/**
 * In-process events, fanned out to every instance through Redis pub/sub when REDIS_URL is set. Used for things
 * any instance may need to act on: session revocation (close sockets), job cancellation, chat stop requests,
 * job progress and notifications for sockets held by another instance.
 */
export class Bus {
  private readonly local = new EventEmitter();
  private readonly instance = randomBytes(8).toString('hex');
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(private readonly log: Logger, redisUrl?: string) {
    this.local.setMaxListeners(100);
    if (redisUrl) {
      this.pub = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 3 });
      this.sub = new Redis(redisUrl, { lazyConnect: false });
      this.pub.on('error', (err) => this.log.warn({ err: err.message }, 'bus publisher error'));
      this.sub.on('error', (err) => this.log.warn({ err: err.message }, 'bus subscriber error'));
      void this.sub.subscribe(CHANNEL).catch((err: Error) => this.log.error({ err: err.message }, 'bus subscribe failed'));
      this.sub.on('message', (_ch: string, raw: string) => {
        try {
          const m = JSON.parse(raw) as { from: string; topic: string; payload: unknown };
          if (m.from !== this.instance) this.local.emit(m.topic, m.payload);
        } catch (err) {
          this.log.warn({ err }, 'bus message dropped');
        }
      });
    }
  }

  get distributed(): boolean {
    return this.pub !== null;
  }

  /** Delivers to local listeners now and to other instances through Redis. */
  publish(topic: string, payload: unknown): void {
    this.local.emit(topic, payload);
    if (this.pub) void this.pub.publish(CHANNEL, JSON.stringify({ from: this.instance, topic, payload })).catch((err: Error) => this.log.warn({ err: err.message, topic }, 'bus publish failed'));
  }

  /** Local only: for events other instances must not also act on (they will have their own). */
  emitLocal(topic: string, payload: unknown): void {
    this.local.emit(topic, payload);
  }

  /**
   * Listeners are isolated: one that throws (or rejects) is logged and skipped, so it cannot fail the publisher, stop
   * later listeners, or keep the event from reaching other instances.
   */
  on<T = unknown>(topic: string, fn: (payload: T) => unknown): () => void {
    const h = (payload: unknown) => {
      try {
        const r = fn(payload as T);
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((err: unknown) => this.log.error({ err, topic }, 'bus listener failed'));
      } catch (err) {
        this.log.error({ err, topic }, 'bus listener failed');
      }
    };
    this.local.on(topic, h);
    return () => this.local.off(topic, h);
  }

  async close(): Promise<void> {
    this.local.removeAllListeners();
    await Promise.all([this.pub?.quit().catch(() => undefined), this.sub?.quit().catch(() => undefined)]);
  }
}

export const TOPICS = {
  sessionsRevoked: 'sessions.revoked',
  jobProgress: 'job.progress',
  jobCancel: 'job.cancel',
  notification: 'notification',
  chatStop: 'chat.stop',
  chatEvent: 'chat.event',
  poolState: 'pool.state',
  auditAppended: 'audit.appended',
  /** Agent-run steps and script runs: `{ userId?, tenantId?, perm?, event, data }`. */
  runEvent: 'run.event',
  /**
   * Events for outbound webhooks that are not audit appends or job states (flags, approvals), emitted locally on the
   * instance where they happen: `{ tenantId, type, label, id, data }`.
   */
  integrationEvent: 'integration.event',
  /** Sprint 16: access to a shared conversation may have ended (a share revoked, a label raised): `ShareAccessEvent`. */
  shareAccess: 'share.access',
  /** Sprint 21 (B-1305): a user left workspaces (removed, or a mapping or directory change): `MembershipEvent`. */
  workspaceMembership: 'workspace.membership'
} as const;

/** Sprint 21: workspaces a user is no longer a member of; live shared watches through them end at once. */
export interface MembershipEvent {
  tenantId: string;
  userId: string;
  workspaceIds: string[];
}

export interface IntegrationEvent {
  tenantId: string;
  /** Event type, e.g. `flag.created` or `approval.requested`. */
  type: string;
  label: 'public' | 'internal' | 'confidential' | 'restricted';
  /** Stable id of the occurrence, so a subscription receives it once. */
  id: string;
  data: Record<string, unknown>;
}
