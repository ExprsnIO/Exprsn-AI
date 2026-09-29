import { ulid } from 'ulid';
import { canonicalJson, sha256 } from '../crypto/index.js';
import { json, type Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import type { Decision, Principal } from '../authz/policy.js';

export const GENESIS = '0'.repeat(64);
export const PLATFORM_TENANT = 'platform';

export type AuditKind = 'auth' | 'decision' | 'admin' | 'correction' | 'system';

export interface AuditActor {
  user?: string;
  username?: string;
  name?: string;
  via?: string;
  session?: string | null;
  apiKey?: string | null;
  roles?: string[];
  service?: string;
  ip?: string | null;
}

export interface AuditInput {
  tenantId: string;
  action: string;
  kind: AuditKind;
  actor: AuditActor;
  target?: Record<string, unknown>;
  label?: Label;
  decision?: Pick<Decision, 'allow' | 'step' | 'reason' | 'policy' | 'action'> & Record<string, unknown>;
  detail?: Record<string, unknown>;
  traceId?: string | null;
  corrects?: string;
}

export interface AuditEvent {
  id: string;
  tenant_id: string;
  seq: number;
  ts: number;
  action: string;
  kind: AuditKind;
  actor: AuditActor;
  target: Record<string, unknown>;
  label: Label;
  decision: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  trace_id: string | null;
  corrects: string | null;
  prev_hash: string;
  hash: string;
}

/** The hash covers every field of the event, including prev_hash, in canonical JSON. */
export function hashEvent(e: Omit<AuditEvent, 'hash'>): string {
  return sha256(canonicalJson(e));
}

export function actorFrom(p: Principal | null | undefined, ip?: string | null): AuditActor {
  if (!p) return { ip: ip ?? null };
  return {
    user: p.userId,
    username: p.username,
    name: p.displayName,
    session: p.sessionId,
    apiKey: p.apiKeyId,
    roles: p.roles,
    ip: ip ?? null
  };
}

/**
 * Append-only, per-tenant hash chain. Appends for one tenant are serialised in-process, and the
 * (tenant_id, seq) unique key makes concurrent writers from other instances fail and retry rather than fork.
 * Rows are never updated or deleted; a mistake is fixed by appending a correction that references it.
 */
export class AuditLog {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly db: Db) {}

  append(input: AuditInput): Promise<AuditEvent> {
    const prev = this.tails.get(input.tenantId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.appendWithRetry(input));
    this.tails.set(input.tenantId, next);
    void next.finally(() => {
      if (this.tails.get(input.tenantId) === next) this.tails.delete(input.tenantId);
    }).catch(() => undefined);
    return next;
  }

  private async appendWithRetry(input: AuditInput, attempt = 0): Promise<AuditEvent> {
    try {
      return await this.appendOnce(input);
    } catch (err) {
      if (attempt < 5 && isUniqueViolation(err)) return this.appendWithRetry(input, attempt + 1);
      throw err;
    }
  }

  private async appendOnce(input: AuditInput): Promise<AuditEvent> {
    return this.db.transaction(async (trx) => {
      const head = (await trx('audit_events')
        .where({ tenant_id: input.tenantId })
        .orderBy('seq', 'desc')
        .first('seq', 'hash')) as { seq: number; hash: string } | undefined;
      const base: Omit<AuditEvent, 'hash'> = {
        id: ulid(),
        tenant_id: input.tenantId,
        seq: head ? Number(head.seq) + 1 : 1,
        ts: Date.now(),
        action: input.action,
        kind: input.kind,
        actor: input.actor,
        target: input.target ?? {},
        label: input.label ?? 'internal',
        decision: input.decision ?? null,
        detail: input.detail ?? null,
        trace_id: input.traceId ?? null,
        corrects: input.corrects ?? null,
        prev_hash: head ? head.hash : GENESIS
      };
      const event: AuditEvent = { ...base, hash: hashEvent(base) };
      await trx('audit_events').insert({
        ...event,
        actor: JSON.stringify(event.actor),
        target: JSON.stringify(event.target),
        decision: event.decision ? JSON.stringify(event.decision) : null,
        detail: event.detail ? JSON.stringify(event.detail) : null
      });
      return event;
    });
  }

  async list(
    tenantId: string,
    opts: { limit?: number; before?: number; kind?: AuditKind; action?: string } = {}
  ): Promise<AuditEvent[]> {
    const q = this.db('audit_events').where({ tenant_id: tenantId });
    if (opts.before) q.andWhere('seq', '<', opts.before);
    if (opts.kind) q.andWhere({ kind: opts.kind });
    // Prefix match as a range, which needs no LIKE escaping and uses the (tenant_id, action) index.
    if (opts.action) q.andWhere('action', '>=', opts.action).andWhere('action', '<', opts.action + '\uffff');
    const rows = await q.orderBy('seq', 'desc').limit(Math.min(opts.limit ?? 100, 500));
    return rows.map(rowToEvent);
  }

  /** Recomputes every hash from genesis to head. Read-only: a break is reported, never repaired. */
  async verify(tenantId: string): Promise<{ status: 'verified' | 'broken'; checked: number; head: string; brokenAt?: { seq: number; id: string; reason: string } }> {
    let prev = GENESIS;
    let expectedSeq = 1;
    let checked = 0;
    const pageSize = 1000;
    for (;;) {
      const rows = await this.db('audit_events')
        .where({ tenant_id: tenantId })
        .andWhere('seq', '>=', expectedSeq)
        .orderBy('seq', 'asc')
        .limit(pageSize);
      for (const row of rows) {
        const e = rowToEvent(row);
        const fail = (reason: string) => ({ status: 'broken' as const, checked, head: prev, brokenAt: { seq: e.seq, id: e.id, reason } });
        if (e.seq !== expectedSeq) return fail(`sequence gap: expected ${expectedSeq}`);
        if (e.prev_hash !== prev) return fail('prev_hash does not match the preceding event');
        const { hash, ...rest } = e;
        if (hashEvent(rest) !== hash) return fail('event content does not match its hash');
        prev = hash;
        expectedSeq++;
        checked++;
      }
      if (rows.length < pageSize) break;
    }
    return { status: 'verified', checked, head: prev };
  }
}

export function rowToEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    seq: Number(row.seq),
    ts: Number(row.ts),
    action: String(row.action),
    kind: row.kind as AuditKind,
    actor: json<AuditActor>(row.actor, {}),
    target: json<Record<string, unknown>>(row.target, {}),
    label: row.label as Label,
    decision: json<Record<string, unknown> | null>(row.decision, null),
    detail: json<Record<string, unknown> | null>(row.detail, null),
    trace_id: (row.trace_id as string | null) ?? null,
    corrects: (row.corrects as string | null) ?? null,
    prev_hash: String(row.prev_hash),
    hash: String(row.hash)
  };
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  return e?.code === '23505' || e?.code === 'ER_DUP_ENTRY' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(e?.message ?? '');
}
