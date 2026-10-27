import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { monotonicFactory } from 'ulid';
import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import type { JournalEntry, OperationState, OperationStep } from './graph.js';
import type { OperationHandle } from './providers/types.js';
import { cloudPlaneMetrics } from './cloud-metrics.js';

/*
 * 1.9.99-final, Sprint 57 (B-10102): the append-only operation journal (`cloud_operations`). Every state of every
 * step of an apply (and of a destroy, a poll, a verify) is a new row: `started` before the provider call, `pending`
 * with the long-running operation's handle, then `succeeded`, `adopted` or `failed`. Rows are never updated, so the
 * journal is what any instance resumes from after a crash: the latest row of a step says whether to skip it (done),
 * poll its stored handle (pending) or run it again with the same idempotency key (started or failed; the adapters'
 * `find` adopts what the lost attempt made).
 */

/** Journal ids: ULIDs that increase within this process even inside one millisecond (the journal's order is by id). */
export const journalId = monotonicFactory();

/** The idempotency key of one step: stable across every attempt and every instance; at most 64 characters (AWS client tokens). */
export function idempotencyKey(deploymentId: string, planId: string | null, key: string, step: OperationStep): string {
  return `exs-${createHash('sha256').update(`${deploymentId}|${planId ?? '-'}|${key}|${step}`).digest('hex').slice(0, 40)}`;
}

const DONE: readonly OperationState[] = ['succeeded', 'adopted'];
export const isDone = (e: JournalEntry | undefined | null): boolean => !!e && DONE.includes(e.state);

function fromRow(r: Record<string, unknown>): JournalEntry {
  return {
    id: String(r.id),
    deploymentId: String(r.deployment_id),
    planId: (r.plan_id as string | null) ?? null,
    resourceKey: String(r.resource_key),
    step: r.step as OperationStep,
    idempotencyKey: String(r.idempotency_key),
    clientToken: (r.client_token as string | null) ?? null,
    providerRequestId: (r.provider_request_id as string | null) ?? null,
    attempt: Number(r.attempt),
    state: r.state as OperationState,
    error: (r.error as string | null) ?? null,
    handle: json<OperationHandle | null>(r.handle, null),
    providerId: (r.provider_id as string | null) ?? null,
    auditId: (r.audit_id as string | null) ?? null,
    jobId: (r.job_id as string | null) ?? null,
    worker: (r.worker as string | null) ?? null,
    at: Number(r.at)
  };
}

export type JournalInput = Omit<JournalEntry, 'id' | 'at' | 'clientToken' | 'providerRequestId' | 'error' | 'handle' | 'providerId' | 'auditId' | 'jobId' | 'worker'> &
  Partial<Pick<JournalEntry, 'id' | 'clientToken' | 'providerRequestId' | 'error' | 'handle' | 'providerId' | 'auditId' | 'jobId' | 'worker'>>;

export interface JournalQuery {
  planId?: string;
  key?: string;
  /** Rows after this id (the journal's order). */
  after?: string;
  limit?: number;
}

export class CloudJournal {
  constructor(private readonly s: () => Services) {}

  /** Appends one row (in the transaction when given). The id may be chosen beforehand (an audit entry names it). */
  async append(input: JournalInput, trx?: Knex.Transaction): Promise<JournalEntry> {
    const at = Date.now();
    const id = input.id ?? journalId();
    const row = {
      id,
      deployment_id: input.deploymentId,
      plan_id: input.planId,
      resource_key: input.resourceKey,
      step: input.step,
      idempotency_key: input.idempotencyKey,
      client_token: input.clientToken ?? null,
      provider_request_id: input.providerRequestId?.slice(0, 200) ?? null,
      attempt: input.attempt,
      state: input.state,
      error: input.error?.slice(0, 2000) ?? null,
      handle: input.handle ? JSON.stringify(input.handle) : null,
      provider_id: input.providerId ?? null,
      audit_id: input.auditId ?? null,
      job_id: input.jobId ?? null,
      worker: input.worker?.slice(0, 120) ?? null,
      at
    };
    await (trx ?? this.s().db)('cloud_operations').insert(row);
    // B-10702: operations by step and state.
    cloudPlaneMetrics(this.s().metrics.registry).journalRow(input.step, input.state);
    return fromRow(row);
  }

  /** The journal of a deployment, oldest first (or of one plan, or one resource). */
  async list(deploymentId: string, q: JournalQuery = {}): Promise<JournalEntry[]> {
    let query = this.s().db('cloud_operations').where({ deployment_id: deploymentId });
    if (q.planId) query = query.andWhere({ plan_id: q.planId });
    if (q.key) query = query.andWhere({ resource_key: q.key });
    if (q.after) query = query.andWhere('id', '>', q.after);
    const rows = await query.orderBy('id', 'asc').limit(Math.min(q.limit ?? 500, 2000));
    return (rows as Record<string, unknown>[]).map(fromRow);
  }

  async get(id: string): Promise<JournalEntry | null> {
    const r = await this.s().db('cloud_operations').where({ id }).first();
    return r ? fromRow(r as Record<string, unknown>) : null;
  }

  /** The latest row of each step of a plan, by `<key>|<step>`. */
  async latest(planId: string): Promise<Map<string, JournalEntry>> {
    const rows = (await this.s().db('cloud_operations').where({ plan_id: planId }).orderBy('id', 'asc')) as Record<string, unknown>[];
    const out = new Map<string, JournalEntry>();
    for (const r of rows) {
      const e = fromRow(r);
      out.set(`${e.resourceKey}|${e.step}`, e);
    }
    return out;
  }

  /** Steps of a deployment whose latest row is `pending` (a long-running operation nobody is polling now). */
  async pending(deploymentId: string): Promise<JournalEntry[]> {
    const rows = (await this.s().db('cloud_operations').where({ deployment_id: deploymentId }).orderBy('id', 'asc')) as Record<string, unknown>[];
    const last = new Map<string, JournalEntry>();
    for (const r of rows) {
      const e = fromRow(r);
      last.set(`${e.planId ?? '-'}|${e.resourceKey}|${e.step}`, e);
    }
    return [...last.values()].filter((e) => e.state === 'pending' && e.handle);
  }

  /** Counts of a plan's rows by state, for the audit summary. */
  async summary(planId: string): Promise<{ rows: number; byState: Record<string, number>; steps: number; requestIds: string[] }> {
    const rows = (await this.s().db('cloud_operations').where({ plan_id: planId }).orderBy('id', 'asc')) as Record<string, unknown>[];
    const byState: Record<string, number> = {};
    const steps = new Set<string>();
    const requestIds: string[] = [];
    for (const r of rows) {
      const e = fromRow(r);
      byState[e.state] = (byState[e.state] ?? 0) + 1;
      steps.add(`${e.resourceKey}|${e.step}`);
      if (e.providerRequestId && !requestIds.includes(e.providerRequestId)) requestIds.push(e.providerRequestId);
    }
    return { rows: rows.length, byState, steps: steps.size, requestIds: requestIds.slice(0, 50) };
  }
}
