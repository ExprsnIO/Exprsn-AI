import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import type { AuditActor, AuditKind } from '../audit/chain.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { platformTenant } from '../ops/common.js';
import { TOPICS } from '../platform/bus.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { SYS_SCOPE } from './policy.js';

/*
 * 1.7.0 (B-9204, B-9203): the generic lease table, `vault_leases`.
 *
 * A lease is a credential with a life: the thing a feature handed out (an API key in B-9301, a session in B-9206),
 * who holds it, and when it ends. The model is the database leases' (B-1704), with their engine taken out:
 *
 * - the renew period is the idle timeout: a lease not renewed (or used, for a lease checked with `touch`) within it
 *   has lapsed and is refused, whether or not the sweeper has reached it yet;
 * - the maximum lifetime is absolute: renewing never moves the expiry past it, and a lease at its maximum cannot be
 *   renewed;
 * - a lease ends by revocation or by the sweeper at expiry. A kind may register a handler that undoes the credential
 *   (deletes the key at its provider); a handler that fails leaves the lease in `revoking`, retried with back-off.
 *
 * A lease may carry a verifier (a digest of the secret its holder presents), so a request finds it with one indexed
 * lookup. `check` keeps the answer in this process for VAULT_LEASE_CACHE_MS; ending a lease publishes `vault.lease`,
 * so every instance drops it at once (with more than one process that needs Redis, B-9001), and a cached answer is
 * never used past its own expiry. The scope of a lease is its tenant, or the platform scope for a service's lease.
 *
 * 1.7.0, Sprint 42 (B-9206): sessions and personal API keys may be leases too (`identity/sessions.ts`,
 * `identity/apikeys.ts`). For them a lease is the store: `held` finds a live one by any of the digests a presented
 * secret may have (one per accepted key version) in one query, `rekey` gives a lease a new verifier and lifetime in
 * place (a session whose token is rotated), `patch` changes its data, and a kind may be `quiet` about being issued or
 * expiring, which for sessions would otherwise write two audit entries per sign-in.
 *
 * The built-in database engines keep their own table (`vault_db_leases`): their rows name an engine, a role and an
 * account, and were not moved.
 */

export type GenericLeaseState = 'active' | 'revoking' | 'revoked' | 'expired';
export type LeaseHolderKind = 'user' | 'api_key' | 'service';

interface Row {
  id: string;
  tenant_id: string;
  kind: string;
  holder_kind: LeaseHolderKind;
  holder: string | null;
  ref: string | null;
  verifier: string | null;
  label: Label;
  data: string;
  state: GenericLeaseState;
  issued_at: number;
  renewed_at: number;
  renew_period_ms: number;
  expires_at: number;
  max_expires_at: number;
  renewals: number;
  ended_at: number | null;
  ended_by: string | null;
  end_reason: string | null;
  attempts: number;
  last_error: string | null;
  next_attempt_at: number | null;
  /** 1.8.0 (B-146): a lease used at most so many times (`spend`); null or absent: no limit. */
  max_uses?: number | null;
  uses_left?: number | null;
}

const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const from = (r: Record<string, unknown>): Row => ({ ...(r as unknown as Row), issued_at: n(r.issued_at), renewed_at: n(r.renewed_at), renew_period_ms: n(r.renew_period_ms), expires_at: n(r.expires_at), max_expires_at: n(r.max_expires_at), renewals: n(r.renewals), ended_at: nn(r.ended_at), attempts: n(r.attempts), next_attempt_at: nn(r.next_attempt_at), max_uses: nn(r.max_uses), uses_left: nn(r.uses_left) });

export interface GenericLease {
  id: string;
  tenantId: string;
  kind: string;
  holderKind: LeaseHolderKind;
  holder: string | null;
  ref: string | null;
  label: Label;
  data: Record<string, unknown>;
  state: GenericLeaseState;
  issuedAt: number;
  renewedAt: number;
  renewPeriodSeconds: number;
  expiresAt: number;
  maxExpiresAt: number;
  renewals: number;
  endedAt: number | null;
  endReason: string | null;
  attempts: number;
  lastError: string | null;
  /** 1.8.0 (B-146): the use limit and what is left of it (as last read; `spend` is the count that decides). */
  maxUses: number | null;
  usesLeft: number | null;
}

const view = (r: Row): GenericLease => ({
  id: r.id,
  tenantId: r.tenant_id,
  kind: r.kind,
  holderKind: r.holder_kind,
  holder: r.holder,
  ref: r.ref,
  label: r.label,
  data: json<Record<string, unknown>>(r.data, {}),
  state: r.state,
  issuedAt: r.issued_at,
  renewedAt: r.renewed_at,
  renewPeriodSeconds: Math.round(r.renew_period_ms / 1000),
  expiresAt: r.expires_at,
  maxExpiresAt: r.max_expires_at,
  renewals: r.renewals,
  endedAt: r.ended_at,
  endReason: r.end_reason,
  attempts: r.attempts,
  lastError: r.last_error,
  maxUses: r.max_uses ?? null,
  usesLeft: r.uses_left ?? null
});

export interface LeaseKindHandler {
  /** Undoes the credential when the lease ends. A throw leaves the lease in `revoking`, to be retried. */
  end?(lease: GenericLease, reason: 'revoked' | 'expired'): Promise<void>;
  /** Audit entries the kind does without: its own feature audits the event, or it happens too often to be one each. */
  quiet?: { issued?: boolean; expired?: boolean };
}

/** A lease with the digest it is found by (B-9206: a session's id is its verifier). */
export interface HeldLease {
  lease: GenericLease;
  verifier: string | null;
}

export interface IssueLease {
  /** The lease's id, when what is leased must name it before it exists (an API key's `lease_id`). */
  id?: string;
  tenantId: string;
  kind: string;
  holderKind: LeaseHolderKind;
  holder?: string | null;
  /** The kind's own id for what is leased (an API key's id). */
  ref?: string | null;
  /** A digest of the secret the holder presents; never the secret. Unique among leases. */
  verifier?: string | null;
  label?: Label;
  data?: Record<string, unknown>;
  /** The idle timeout: the lease lapses when it is not renewed within it. */
  renewPeriodSeconds: number;
  /** The absolute lifetime. */
  maxLifetimeSeconds: number;
  /** 1.8.0 (B-146): the most times the lease may be used (`spend`); absent: no limit. */
  maxUses?: number | null;
  actor: AuditActor;
  traceId?: string | null;
}

const SWEEP_JOB = 'vault.leases.generic-sweep';
const CLAIM_MS = 5 * 60_000;
const backoff = (attempts: number): number => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
const gone = (detail: string, state: string) => new HttpProblem(410, 'Gone', detail, { extensions: { state } });

export class GenericLeases {
  private readonly kinds = new Map<string, LeaseKindHandler>();
  /** Active leases by id and by verifier, with when they were read. */
  private readonly cache = new Map<string, { row: Row; at: number }>();
  private listening = false;
  /** How many times `check` read the table (tests check that a warm cache reads nothing). */
  lookups = 0;

  constructor(
    private readonly s: () => Services,
    private readonly opts: { cacheMs: number; sweepSeconds: number; cacheMax?: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  /** A kind's handler. A kind without one needs nothing undone when its leases end. */
  registerKind(kind: string, handler: LeaseKindHandler): void {
    this.kinds.set(kind, handler);
  }

  registerJobs(): void {
    this.s().jobs.register(SWEEP_JOB, async (_p, ctx) => {
      const out = await this.sweep();
      await ctx.progress(100, `${out.ended} ended, ${out.failed} to retry`);
      return out;
    });
    this.listen();
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(SWEEP_JOB, this.opts.sweepSeconds * 1000, async () => {
      const now = Date.now();
      const due = await this.db('vault_leases')
        .where((q) => q.where('state', 'active').andWhere('expires_at', '<=', now))
        .orWhere((q) => q.where('state', 'revoking').andWhere((w) => w.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
        .first('id');
      return due ? [{ tenantId: SYS_SCOPE, key: 'all' }] : [];
    });
  }

  /** Drops a lease from this instance's cache when any instance says it changed. */
  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.s().bus.on<{ id?: string; verifier?: string | null }>(TOPICS.vaultLease, (e) => this.forget(e?.id, e?.verifier));
  }

  private forget(id?: string | null, verifier?: string | null): void {
    if (id) this.cache.delete('i:' + id);
    if (verifier) this.cache.delete('v:' + verifier);
  }

  private remember(row: Row): void {
    if (this.opts.cacheMs <= 0) return;
    if (this.cache.size >= (this.opts.cacheMax ?? 50_000)) this.cache.clear();
    const e = { row, at: Date.now() };
    this.cache.set('i:' + row.id, e);
    if (row.verifier) this.cache.set('v:' + row.verifier, e);
  }

  private changed(row: Pick<Row, 'id' | 'verifier'>): void {
    this.forget(row.id, row.verifier);
    this.s().bus.publish(TOPICS.vaultLease, { id: row.id, verifier: row.verifier });
  }

  private async audit(tenantId: string, action: string, kind: AuditKind, actor: AuditActor, r: Row, detail?: Record<string, unknown>, traceId?: string | null): Promise<void> {
    const chain = tenantId === SYS_SCOPE ? await platformTenant(this.s()) : tenantId;
    if (!chain) return;
    await this.s().audit.append({ tenantId: chain, action, kind, actor, target: { lease: r.id, kind: r.kind, ...(r.ref ? { ref: r.ref } : {}), ...(tenantId === SYS_SCOPE ? { scope: 'sys' } : {}) }, label: r.label, ...(detail ? { detail } : {}), traceId: traceId ?? null });
  }

  async issue(input: IssueLease): Promise<GenericLease> {
    if (input.renewPeriodSeconds < 1 || input.maxLifetimeSeconds < 1) throw conflict('A lease needs a renew period and a maximum lifetime of at least a second.');
    this.listen();
    const now = Date.now();
    const max = now + input.maxLifetimeSeconds * 1000;
    const row: Row = {
      id: input.id ?? ulid(),
      tenant_id: input.tenantId,
      kind: input.kind,
      holder_kind: input.holderKind,
      holder: input.holder ?? null,
      ref: input.ref ?? null,
      verifier: input.verifier ?? null,
      label: input.label ?? 'internal',
      data: JSON.stringify(input.data ?? {}),
      state: 'active',
      issued_at: now,
      renewed_at: now,
      renew_period_ms: input.renewPeriodSeconds * 1000,
      expires_at: Math.min(now + input.renewPeriodSeconds * 1000, max),
      max_expires_at: max,
      renewals: 0,
      ended_at: null,
      ended_by: null,
      end_reason: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      ...(input.maxUses ? { max_uses: input.maxUses, uses_left: input.maxUses } : {})
    };
    await this.db('vault_leases').insert(row);
    if (!this.kinds.get(input.kind)?.quiet?.issued) await this.audit(input.tenantId, 'vault.lease.issued', 'decision', input.actor, row, { holderKind: row.holder_kind, holder: row.holder, renewPeriodSeconds: input.renewPeriodSeconds, maxLifetimeSeconds: input.maxLifetimeSeconds }, input.traceId);
    return view(row);
  }

  /**
   * The lease behind an id or a verifier when it is live now, else null: revoked, expired, idle past its renew
   * period, or unknown. One indexed lookup, none with a warm cache. With `touch` a use counts as a renewal: the
   * expiry moves by the renew period (written at most once per tenth of the period), never past the maximum.
   */
  async check(by: { id: string } | { verifier: string }, opts: { touch?: boolean; touchGapMs?: number } = {}): Promise<GenericLease | null> {
    return (await this.live('id' in by ? { id: by.id } : { verifiers: [by.verifier] }, opts))?.lease ?? null;
  }

  /**
   * The live lease behind any of the digests a presented secret may have (one per accepted key version, the current
   * first), with the digest it was found by. One query for all of them, none with a warm cache (B-9206).
   */
  async held(verifiers: string[], opts: { touch?: boolean; touchGapMs?: number } = {}): Promise<HeldLease | null> {
    return verifiers.length ? this.live({ verifiers }, opts) : null;
  }

  private async live(by: { id: string } | { verifiers: string[] }, opts: { touch?: boolean; touchGapMs?: number }): Promise<HeldLease | null> {
    this.listen();
    const keys = 'id' in by ? ['i:' + by.id] : by.verifiers.map((v) => 'v:' + v);
    const now = Date.now();
    let row: Row | undefined;
    for (const key of keys) {
      const hit = this.cache.get(key);
      if (hit && now - hit.at > this.opts.cacheMs) this.cache.delete(key);
      else if (hit) {
        row = hit.row;
        break;
      }
    }
    if (!row) {
      this.lookups++;
      const q = this.db('vault_leases');
      const r = (await ('id' in by ? q.where({ id: by.id }) : by.verifiers.length === 1 ? q.where({ verifier: by.verifiers[0] }) : q.whereIn('verifier', by.verifiers)).first()) as Record<string, unknown> | undefined;
      if (!r) return null;
      row = from(r);
      if (row.state === 'active' && row.expires_at > now) this.remember(row);
    }
    if (row.state !== 'active' || row.expires_at <= now) {
      this.forget(row.id, row.verifier);
      return null;
    }
    if (opts.touch && now - row.renewed_at >= (opts.touchGapMs ?? Math.max(1000, row.renew_period_ms / 10))) {
      const next = Math.min(now + row.renew_period_ms, row.max_expires_at);
      if (next > row.expires_at) {
        const moved = await this.db('vault_leases').where({ id: row.id, state: 'active' }).andWhere('expires_at', '>', now).update({ expires_at: next, renewed_at: now });
        if (!moved) {
          this.forget(row.id, row.verifier);
          return null;
        }
        row = { ...row, expires_at: next, renewed_at: now };
        this.remember(row);
      }
    }
    return { lease: view(row), verifier: row.verifier };
  }

  /**
   * Records a use of a live lease: its expiry moves to `expiresAt` (the caller's idle timeout from now, never past
   * the maximum it read). One write and no read, so a request that found its lease makes no second lookup (B-9206).
   */
  async use(id: string, expiresAt: number): Promise<boolean> {
    const now = Date.now();
    const n = await this.db('vault_leases').where({ id, state: 'active' }).andWhere('expires_at', '>', now).andWhere('max_expires_at', '>=', expiresAt).update({ expires_at: expiresAt, renewed_at: now });
    const hit = this.cache.get('i:' + id);
    if (hit && n) hit.row = { ...hit.row, expires_at: expiresAt, renewed_at: now };
    else if (hit) this.forget(hit.row.id, hit.row.verifier);
    return n > 0;
  }

  /**
   * 1.8.0 (B-146): spends one use of a live, use-limited lease: one conditional update (`uses_left > 0`), so instances
   * sharing the table never accept more uses than the limit between them. `ok` false: none left (or not live). `left`
   * is what remains after this use; at 0 the caller ends what the lease holds (a key through its own service).
   */
  async spend(id: string): Promise<{ ok: boolean; left: number }> {
    const now = Date.now();
    const n = await this.db('vault_leases').where({ id, state: 'active' }).andWhere('expires_at', '>', now).andWhere('uses_left', '>', 0).decrement('uses_left', 1);
    if (!n) return { ok: false, left: 0 };
    const r = (await this.db('vault_leases').where({ id }).first('uses_left')) as { uses_left: unknown } | undefined;
    const left = Math.max(0, Number(r?.uses_left ?? 0));
    const hit = this.cache.get('i:' + id);
    if (hit) hit.row = { ...hit.row, uses_left: left };
    return { ok: true, left };
  }

  /** The lease behind a digest in whatever state it is (not cached): a session looked up by its id. */
  async findByVerifier(verifier: string): Promise<HeldLease | null> {
    const r = (await this.db('vault_leases').where({ verifier }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const row = from(r);
    return { lease: view(row), verifier: row.verifier };
  }

  /** Leases of a kind that have not ended and are not past their expiry, newest use first, with their digests. */
  async liveOf(where: { kind: string; tenantId?: string; holder?: string }, limit = 1000): Promise<HeldLease[]> {
    const q = this.db('vault_leases').where({ kind: where.kind, state: 'active' }).andWhere('expires_at', '>', Date.now());
    if (where.tenantId) q.andWhere({ tenant_id: where.tenantId });
    if (where.holder) q.andWhere({ holder: where.holder });
    return ((await q.orderBy('renewed_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(from).map((row) => ({ lease: view(row), verifier: row.verifier }));
  }

  /** Merges `patch` into a live lease's data (nothing secret). False when the lease is no longer live. */
  async patch(id: string, patch: Record<string, unknown>): Promise<boolean> {
    const r = (await this.db('vault_leases').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) return false;
    const row = from(r);
    if (row.state !== 'active') return false;
    const data = JSON.stringify({ ...json<Record<string, unknown>>(row.data, {}), ...patch });
    const n = await this.db('vault_leases').where({ id, state: 'active' }).update({ data });
    this.changed(row);
    return n > 0;
  }

  /**
   * Gives a live lease a new verifier and a new life in place: the old digest stops finding it at once, on every
   * instance. For a session whose token is rotated when its privilege changes (B-9206). Null when it is not live.
   */
  async rekey(id: string, next: { verifier: string; data: Record<string, unknown>; renewPeriodSeconds: number; maxExpiresAt: number }): Promise<HeldLease | null> {
    const r = (await this.db('vault_leases').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const row = from(r);
    const now = Date.now();
    if (row.state !== 'active' || row.expires_at <= now) return null;
    const upd = { verifier: next.verifier, data: JSON.stringify(next.data), renewed_at: now, renew_period_ms: next.renewPeriodSeconds * 1000, expires_at: Math.min(now + next.renewPeriodSeconds * 1000, next.maxExpiresAt), max_expires_at: next.maxExpiresAt };
    const n = await this.db('vault_leases').where({ id, state: 'active', verifier: row.verifier }).update(upd);
    if (!n) return null;
    this.changed(row);
    const after = { ...row, ...upd };
    this.changed(after);
    return { lease: view(after), verifier: after.verifier };
  }

  /** Ends every live lease of a kind for a holder or a tenant; returns what was ended, with the digests. */
  async endWhere(where: { kind: string; tenantId?: string; holder?: string; exceptVerifier?: string }, actor: AuditActor, by: string | null = null): Promise<HeldLease[]> {
    if (!where.tenantId && !where.holder) return [];
    const q = this.db('vault_leases').where({ kind: where.kind, state: 'active' });
    if (where.tenantId) q.andWhere({ tenant_id: where.tenantId });
    if (where.holder) q.andWhere({ holder: where.holder });
    const rows = ((await q) as Record<string, unknown>[]).map(from).filter((l) => !where.exceptVerifier || l.verifier !== where.exceptVerifier);
    for (const l of rows) await this.end(l, 'revoked', actor, by);
    return rows.map((row) => ({ lease: view(row), verifier: row.verifier }));
  }

  /** Deletes the ended leases of a kind that ended before `before` (sessions keep no history past a day). */
  async purgeEnded(kind: string, before: number): Promise<number> {
    return this.db('vault_leases').where({ kind }).whereIn('state', ['revoked', 'expired']).andWhere('ended_at', '<', before).delete();
  }

  private async row(tenantId: string, id: string): Promise<Row> {
    const r = (await this.db('vault_leases').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Lease');
    return from(r);
  }

  async get(tenantId: string, id: string): Promise<GenericLease> {
    return view(await this.row(tenantId, id));
  }

  async list(tenantId: string, opts: { kind?: string; state?: GenericLeaseState; holder?: string; limit?: number } = {}): Promise<GenericLease[]> {
    const q = this.db('vault_leases').where({ tenant_id: tenantId });
    if (opts.kind) q.andWhere({ kind: opts.kind });
    if (opts.state) q.andWhere({ state: opts.state });
    if (opts.holder) q.andWhere({ holder: opts.holder });
    return ((await q.orderBy('issued_at', 'desc').limit(Math.min(opts.limit ?? 200, 1000))) as Record<string, unknown>[]).map(from).map(view);
  }

  /**
   * Moves the expiry by the renew period. Refused (410) once the lease has ended or sat idle past its renew period,
   * and (409) when it has reached its maximum lifetime: a new lease is taken instead.
   */
  async renew(tenantId: string, id: string, actor: AuditActor, traceId?: string | null): Promise<GenericLease> {
    const l = await this.row(tenantId, id);
    const now = Date.now();
    if (l.state !== 'active') throw gone(`Lease ${l.id} has ended (${l.state}); take a new one.`, l.state);
    if (l.expires_at <= now) throw gone(`Lease ${l.id} was not renewed within its renew period of ${Math.round(l.renew_period_ms / 1000)} seconds and has lapsed; take a new one.`, 'expired');
    if (l.expires_at >= l.max_expires_at) throw new HttpProblem(409, 'Conflict', `Lease ${l.id} is at its maximum lifetime and cannot be renewed; take a new one.`, { extensions: { step: 'lease-maximum', maxExpiresAt: l.max_expires_at } });
    const next = Math.min(now + l.renew_period_ms, l.max_expires_at);
    const moved = await this.db('vault_leases').where({ id: l.id, state: 'active', renewals: l.renewals }).andWhere('expires_at', '>', now).update({ expires_at: next, renewed_at: now, renewals: l.renewals + 1 });
    if (!moved) throw conflict('The lease changed at the same time; read it and try again.');
    const after = { ...l, expires_at: next, renewed_at: now, renewals: l.renewals + 1 };
    this.changed(after);
    await this.audit(tenantId, 'vault.lease.renewed', 'decision', actor, after, { from: l.expires_at, to: next, capped: next >= l.max_expires_at }, traceId);
    return view(after);
  }

  /** Ends a lease now. Every instance refuses it once the event reaches it, and at the latest when its cache entry ages out. */
  async revoke(tenantId: string, id: string, actor: AuditActor, opts: { by?: string | null; traceId?: string | null } = {}): Promise<GenericLease> {
    const l = await this.row(tenantId, id);
    if (l.state === 'revoked' || l.state === 'expired') return view(l);
    await this.end(l, 'revoked', actor, opts.by ?? null, opts.traceId);
    return this.get(tenantId, id);
  }

  /** Every live lease of a holder or for a ref (a user disabled, an API key deleted). */
  async revokeWhere(tenantId: string, where: { kind?: string; holder?: string; ref?: string }, actor: AuditActor): Promise<number> {
    if (!where.holder && !where.ref) return 0;
    const q = this.db('vault_leases').where({ tenant_id: tenantId }).whereIn('state', ['active', 'revoking']);
    if (where.kind) q.andWhere({ kind: where.kind });
    if (where.holder) q.andWhere({ holder: where.holder });
    if (where.ref) q.andWhere({ ref: where.ref });
    const rows = ((await q) as Record<string, unknown>[]).map(from);
    for (const l of rows) await this.end(l, 'revoked', actor, null);
    return rows.length;
  }

  /**
   * The lease stops being accepted first (state `revoking`, the event published), then the kind's handler undoes the
   * credential. A handler that fails leaves it in `revoking` for the sweeper.
   */
  private async end(l: Row, reason: 'revoked' | 'expired', actor: AuditActor, by: string | null, traceId?: string | null): Promise<boolean> {
    if (l.state === 'active') await this.db('vault_leases').where({ id: l.id, state: 'active' }).update({ state: 'revoking', end_reason: reason });
    this.changed(l);
    try {
      await this.kinds.get(l.kind)?.end?.(view({ ...l, state: 'revoking' }), reason);
    } catch (err) {
      const message = (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 500);
      const attempts = l.attempts + 1;
      await this.db('vault_leases').where({ id: l.id }).update({ state: 'revoking', end_reason: reason, attempts, last_error: message, next_attempt_at: Date.now() + backoff(attempts) });
      await this.audit(l.tenant_id, 'vault.lease.revoke-failed', 'system', actor, l, { reason, attempts, error: message }, traceId);
      return false;
    }
    const now = Date.now();
    await this.db('vault_leases').where({ id: l.id }).update({ state: reason, ended_at: now, ended_by: by, end_reason: reason, last_error: null, next_attempt_at: null });
    if (!(reason === 'expired' && this.kinds.get(l.kind)?.quiet?.expired)) await this.audit(l.tenant_id, reason === 'expired' ? 'vault.lease.expired' : 'vault.lease.revoked', reason === 'expired' ? 'system' : 'decision', actor, l, { issuedAt: l.issued_at, expiresAt: l.expires_at, renewals: l.renewals }, traceId);
    return true;
  }

  /** Ends every lease past its expiry, and retries the ends that failed before and are due again. */
  async sweep(): Promise<{ ended: number; failed: number }> {
    const now = Date.now();
    const due = ((await this.db('vault_leases')
      .where((q) => q.where('state', 'active').andWhere('expires_at', '<=', now))
      .orWhere((q) => q.where('state', 'revoking').andWhere((w) => w.whereNull('next_attempt_at').orWhere('next_attempt_at', '<=', now)))
      .orderBy('expires_at')
      .limit(500)) as Record<string, unknown>[]).map(from);
    let ended = 0;
    let failed = 0;
    for (const l of due) {
      const reason = l.state === 'active' ? 'expired' : ((l.end_reason as 'revoked' | 'expired' | null) ?? 'expired');
      // Claimed, so two instances never end the same lease at once.
      const q = this.db('vault_leases').where({ id: l.id, state: l.state, attempts: l.attempts });
      if (l.next_attempt_at == null) q.whereNull('next_attempt_at');
      else q.andWhere({ next_attempt_at: l.next_attempt_at });
      if (!(await q.update({ state: 'revoking', end_reason: reason, next_attempt_at: now + CLAIM_MS }))) continue;
      if (await this.end({ ...l, state: 'revoking' }, reason, { service: 'vault.leases' }, null)) ended++;
      else failed++;
    }
    return { ended, failed };
  }
}
