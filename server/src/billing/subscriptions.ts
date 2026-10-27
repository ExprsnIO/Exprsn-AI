import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import type { AuditActor } from '../audit/chain.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { cycleAmount, PlanCatalogue, planAt, type PlanAt, type PlanRow, type PlanVersionRow } from './plans.js';

export type { PlanAt };
import { cycleBounds, CYCLE_MONTHS, mulDiv } from './cycles.js';
import type { Meter } from './service.js';
import type { Cycle, CycleKind, SubscriptionAt, SubscriptionPeriod, SubscriptionSource } from './types.js';

type MeterName = Meter;

export type SubscriptionState = 'trialing' | 'active' | 'paused' | 'cancelled' | 'ended';

/** States that charge the plan. A trial, a pause and a finished subscription charge nothing for their time. */
export const CHARGEABLE_STATES: readonly SubscriptionState[] = ['active'];

/** `at()`: the engine's `SubscriptionAt` (whose prices are 0 while the state does not charge), and more. */
export interface SubscriptionAtDetail extends SubscriptionAt {
  plan: PlanAt;
  planKey: string;
  planVersion: number;
  state: SubscriptionState;
  trialEnd: number | null;
  startedAt: number;
  cancelAtPeriodEnd: boolean;
  /** The list cycle amount with seats, whatever the state. */
  cycleAmountMinor: number;
}

/** `periods()`: the engine's stretch, and what state the subscription was in over it. */
export interface SubscriptionStretch extends SubscriptionPeriod {
  state: SubscriptionState;
  planKey: string;
  planVersion: number;
}

/** A stretch of one period over which nothing about the subscription changed (the console's and tests' view). */
export interface PeriodSegment {
  from: number;
  to: number;
  state: SubscriptionState;
  plan: PlanAt;
  seats: number;
  includedSeats: number;
  fraction: number;
  cycleAmountMinor: number;
  amountMinor: number;
  /** This segment's share of the allowances (rounded down), and the whole cycle's at its plan. */
  allowances: Partial<Record<MeterName, number>>;
  cycleAllowances: Partial<Record<MeterName, number>>;
}

/** Something that changed in the middle of a period, with its proration (credit ≤ 0, charge ≥ 0, net = their sum). */
export interface PeriodChange {
  at: number;
  kind: string;
  from: { planKey: string; planVersion: number; seats: number; state: SubscriptionState };
  to: { planKey: string; planVersion: number; seats: number; state: SubscriptionState };
  remainingSeconds: number;
  periodSeconds: number;
  creditMinor: number;
  chargeMinor: number;
  netMinor: number;
  eventId: string | null;
}

/** One billing period in full: the in-advance opening charge, its stretches and its mid-period changes. */
export interface CycleDetail {
  subscriptionId: string;
  currency: string;
  cycle: Cycle;
  periodStart: number;
  periodEnd: number;
  fullStart: number;
  opening: { plan: PlanAt; seats: number; includedSeats: number; state: SubscriptionState; cycleAmountMinor: number; fraction: number; chargeMinor: number };
  segments: PeriodSegment[];
  changes: PeriodChange[];
  allowances: Partial<Record<MeterName, number>>;
  final: boolean;
}

/*
 * 1.9.0, Sprint 51 (B-162): a tenant's subscription to a plan, with its full history.
 *
 * - One live subscription per tenant (`live_tenant`). Its cycle is monthly, quarterly, annual or a custom 1 to 36
 *   months, with periods starting on an anchor day (1 to 28, UTC midnight). The first period runs from the start to the
 *   first anchor and is prorated against a whole cycle.
 * - Time moves a subscription on by itself: a trial ends into `active` at its end, a period renews at its end (a
 *   change scheduled for renewal is applied then, and the plan's newest approved version takes over), a cancellation
 *   at period end takes effect at the period's end, a fixed end (`ends_at`) ends it. `project` computes these
 *   deterministically, so `at()` and `periods()` answer for any moment from the stored history, and the
 *   `billing.subscriptions.tick` job writes the same transitions into the history (dated when they took effect).
 * - Every change is an append-only row of `billing_subscription_events` with the state after it. A statement asks
 *   what applied at time T (`at`) or what happened over a range of time (`periods`).
 * - Proration: see `billing/types.ts`. Credits and charges are in integer minor units, rounded half away from zero.
 */

/** A subscription's state at one moment: what the history stores after every change. */
export interface Snapshot {
  planId: string;
  planVersion: number;
  seats: number;
  currency: string;
  state: SubscriptionState;
  trialEnd: number | null;
  startedAt: number;
  endsAt: number | null;
  cycle: Cycle;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  pausedAt: number | null;
  finishedAt: number | null;
  /** A plan or seat change scheduled for the next renewal, with the plan version it was quoted at. */
  pendingChange: { planId: string; planVersion: number; seats: number } | null;
}

export interface SubscriptionRow extends Snapshot {
  id: string;
  tenantId: string;
  rev: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SubscriptionEvent {
  id: string;
  subscriptionId: string;
  tenantId: string;
  seq: number;
  at: number;
  kind: string;
  snapshot: Snapshot;
  detail: Record<string, unknown> | null;
  actor: string | null;
  recordedAt: number;
}

/** Who acts on a subscription. `platform` lets them use private plans and set the trial; `null` is the tick. */
export interface SubscriptionActor {
  tenantId: string;
  userId: string;
  actor: AuditActor;
  traceId?: string;
  platform: boolean;
}

/** Plan versions by plan id (approved, oldest first) and the plans themselves: what projection prices from. */
export interface PlanBook {
  plans: Map<string, PlanRow>;
  versions: Map<string, PlanVersionRow[]>;
}

export const FINISHED: readonly SubscriptionState[] = ['cancelled', 'ended'];
const DAY = 86_400_000;
const MAX_STEPS = 5000;

/** Exact proration: `amount × part / whole`, rounded half away from zero to a whole minor unit (`mulDiv`). */
export function prorate(amountMinor: number, partSeconds: number, wholeSeconds: number): number {
  if (wholeSeconds <= 0 || partSeconds <= 0 || amountMinor === 0) return 0;
  if (partSeconds >= wholeSeconds) return amountMinor;
  return mulDiv(amountMinor, partSeconds, wholeSeconds);
}

/** Whole seconds from `a` to `b` (ms). */
const secs = (a: number, b: number): number => Math.floor(b / 1000) - Math.floor(a / 1000);

/**
 * The period containing `t` (≥ the start): `[start, end)` and the whole cycle it belongs to (`fullStart`), from the
 * engine's `cycleBounds`. The first period starts at the start; its whole cycle starts at the anchor before it.
 */
export function periodAt(startedAt: number, c: Cycle, t: number): { start: number; end: number; fullStart: number } {
  const b = cycleBounds(c, startedAt, Math.max(t, startedAt));
  return { start: Math.max(b.start, startedAt), end: b.end, fullStart: b.start };
}

export const cycleOf = (kind: CycleKind, months: number | undefined, anchorDay: number): Cycle => {
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 28) throw badRequest('An anchor day is 1 to 28.', { field: 'cycle.anchorDay' });
  if (kind !== 'custom') return { kind, months: CYCLE_MONTHS[kind], anchorDay };
  if (!months || !Number.isInteger(months) || months < 1 || months > 36) throw badRequest('A custom cycle runs 1 to 36 months.', { field: 'cycle.months' });
  return { kind, months, anchorDay };
};

const versionOf = (book: PlanBook, planId: string, version: number): PlanVersionRow | null => book.versions.get(planId)?.find((v) => v.version === version) ?? null;
const newestAt = (book: PlanBook, planId: string, t: number): PlanVersionRow | null => PlanCatalogue.inForce(book.versions.get(planId) ?? [], t);

/** The plan a snapshot is priced by (the version it names), in its currency and cycle. */
export function planOf(book: PlanBook, s: Pick<Snapshot, 'planId' | 'planVersion' | 'currency' | 'cycle'>): (PlanAt & { includedSeats: number }) | null {
  const plan = book.plans.get(s.planId);
  const v = versionOf(book, s.planId, s.planVersion);
  return plan && v ? planAt(plan, v, s.currency, s.cycle.months) : null;
}

/** What a snapshot charges per whole cycle (0 unless its state charges). */
export function chargeableAmount(book: PlanBook, s: Snapshot): number {
  if (!CHARGEABLE_STATES.includes(s.state)) return 0;
  const p = planOf(book, s);
  return p ? cycleAmount(p, p.includedSeats, s.seats) : 0;
}

/** A transition time brings by itself. */
export interface Transition {
  at: number;
  kind: 'trial-ended' | 'renewed' | 'cancelled' | 'ended';
  snapshot: Snapshot;
  detail: Record<string, unknown>;
}

/**
 * Moves a snapshot on to `until` (inclusive), returning each transition in order. Pure: the same history and plan
 * versions always give the same answer, whenever it is asked.
 */
export function project(start: Snapshot, book: PlanBook, until: number): Transition[] {
  const out: Transition[] = [];
  let s = { ...start };
  for (let i = 0; i < MAX_STEPS; i++) {
    if (FINISHED.includes(s.state)) break;
    const candidates: { at: number; kind: Transition['kind'] }[] = [];
    if (s.state === 'trialing' && s.trialEnd != null) candidates.push({ at: s.trialEnd, kind: 'trial-ended' });
    if (s.endsAt != null) candidates.push({ at: s.endsAt, kind: 'ended' });
    candidates.push({ at: s.periodEnd, kind: s.cancelAtPeriodEnd ? 'cancelled' : 'renewed' });
    // At the same moment: a fixed end first, then cancellation, then the trial, then renewal.
    const order = { ended: 0, cancelled: 1, 'trial-ended': 2, renewed: 3 } as const;
    candidates.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
    const next = candidates[0]!;
    if (next.at > until) break;
    const detail: Record<string, unknown> = {};
    if (next.kind === 'trial-ended') {
      s = { ...s, state: 'active', trialEnd: s.trialEnd };
    } else if (next.kind === 'ended' || next.kind === 'cancelled') {
      s = { ...s, state: next.kind, finishedAt: next.at, pausedAt: null, pendingChange: null };
    } else {
      const p = periodAt(s.startedAt, s.cycle, next.at);
      const change = s.pendingChange;
      const planId = change?.planId ?? s.planId;
      const newest = newestAt(book, planId, next.at);
      if (change) Object.assign(detail, { applied: { planId: change.planId, seats: change.seats }, before: { planId: s.planId, planVersion: s.planVersion, seats: s.seats } });
      if (newest && newest.version !== s.planVersion) Object.assign(detail, { planVersion: { from: s.planVersion, to: newest.version } });
      s = { ...s, planId, planVersion: newest?.version ?? change?.planVersion ?? s.planVersion, seats: change?.seats ?? s.seats, periodStart: p.start, periodEnd: p.end, pendingChange: null };
      // A trial that ends exactly at the renewal is handled first (above), so a trialing state here outlasts it.
    }
    out.push({ at: next.at, kind: next.kind, snapshot: { ...s }, detail });
  }
  return out;
}

const rowToSub = (r: Record<string, unknown>): SubscriptionRow => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  planId: String(r.plan_id),
  planVersion: Number(r.plan_version),
  seats: Number(r.seats),
  currency: String(r.currency),
  state: r.state as SubscriptionState,
  trialEnd: r.trial_end == null ? null : Number(r.trial_end),
  startedAt: Number(r.started_at),
  endsAt: r.ends_at == null ? null : Number(r.ends_at),
  cycle: { kind: r.cycle_kind as CycleKind, months: Number(r.cycle_months), anchorDay: Number(r.anchor_day) },
  periodStart: Number(r.period_start),
  periodEnd: Number(r.period_end),
  cancelAtPeriodEnd: !!r.cancel_at_period_end,
  pausedAt: r.paused_at == null ? null : Number(r.paused_at),
  finishedAt: r.finished_at == null ? null : Number(r.finished_at),
  pendingChange: json<Snapshot['pendingChange']>(r.pending_change, null),
  rev: Number(r.rev ?? 0),
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
});

const snapshotOf = (r: Snapshot): Snapshot => ({ planId: r.planId, planVersion: r.planVersion, seats: r.seats, currency: r.currency, state: r.state, trialEnd: r.trialEnd, startedAt: r.startedAt, endsAt: r.endsAt, cycle: { ...r.cycle }, periodStart: r.periodStart, periodEnd: r.periodEnd, cancelAtPeriodEnd: r.cancelAtPeriodEnd, pausedAt: r.pausedAt, finishedAt: r.finishedAt, pendingChange: r.pendingChange ? { ...r.pendingChange } : null });

const columnsOf = (s: Snapshot, tenantId: string) => ({
  live_tenant: FINISHED.includes(s.state) ? null : tenantId,
  plan_id: s.planId,
  plan_version: s.planVersion,
  seats: s.seats,
  currency: s.currency,
  state: s.state,
  trial_end: s.trialEnd,
  started_at: s.startedAt,
  ends_at: s.endsAt,
  cycle_kind: s.cycle.kind,
  cycle_months: s.cycle.months,
  anchor_day: s.cycle.anchorDay,
  period_start: s.periodStart,
  period_end: s.periodEnd,
  cancel_at_period_end: s.cancelAtPeriodEnd,
  paused_at: s.pausedAt,
  finished_at: s.finishedAt,
  pending_change: s.pendingChange ? JSON.stringify(s.pendingChange) : null
});

const eventFromRow = (r: Record<string, unknown>): SubscriptionEvent => ({
  id: String(r.id),
  subscriptionId: String(r.subscription_id),
  tenantId: String(r.tenant_id),
  seq: Number(r.seq),
  at: Number(r.at),
  kind: String(r.kind),
  snapshot: json<Snapshot>(r.snapshot, null as unknown as Snapshot),
  detail: json<Record<string, unknown> | null>(r.detail, null),
  actor: (r.actor as string | null) ?? null,
  recordedAt: Number(r.recorded_at)
});

/** The proration of a change at `at` inside the snapshot's period: credit the old for the rest, charge the new. */
export function prorationOf(book: PlanBook, before: Snapshot, after: Snapshot, at: number): { remainingSeconds: number; periodSeconds: number; creditMinor: number; chargeMinor: number; netMinor: number } {
  const p = periodAt(before.startedAt, before.cycle, at);
  const remainingSeconds = Math.max(0, secs(at, p.end));
  const periodSeconds = secs(p.fullStart, p.end);
  const creditMinor = -prorate(chargeableAmount(book, before), remainingSeconds, periodSeconds);
  const chargeMinor = prorate(chargeableAmount(book, after), remainingSeconds, periodSeconds);
  return { remainingSeconds, periodSeconds, creditMinor: creditMinor === 0 ? 0 : creditMinor, chargeMinor, netMinor: creditMinor + chargeMinor };
}

const allowancesFor = (book: PlanBook, s: Snapshot): Partial<Record<MeterName, number>> => {
  const v = versionOf(book, s.planId, s.planVersion);
  const out: Partial<Record<MeterName, number>> = {};
  for (const [m, n] of Object.entries(v?.allowances ?? {})) out[m as MeterName] = Number(n) * s.cycle.months;
  return out;
};

export class SubscriptionService implements SubscriptionSource {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** The plans and approved versions named by some snapshots (and by the changes they schedule). */
  async book(snaps: readonly Pick<Snapshot, 'planId' | 'pendingChange'>[]): Promise<PlanBook> {
    const ids = [...new Set(snaps.flatMap((x) => [x.planId, ...(x.pendingChange ? [x.pendingChange.planId] : [])]))];
    const plans = new Map<string, PlanRow>();
    if (ids.length) for (const p of await Promise.all(ids.map((id) => this.s().plans.get(id).catch(() => null)))) if (p) plans.set(p.id, p);
    return { plans, versions: await this.s().plans.approvedOf(ids) };
  }

  async current(tenantId: string): Promise<SubscriptionRow | null> {
    const r = await this.db('billing_subscriptions').where({ live_tenant: tenantId }).first();
    return r ? rowToSub(r) : null;
  }

  /** The tenant's subscriptions, newest first. */
  async list(tenantId: string, limit = 20): Promise<SubscriptionRow[]> {
    return ((await this.db('billing_subscriptions').where({ tenant_id: tenantId }).orderBy('started_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(rowToSub);
  }

  async history(tenantId: string, opts: { subscriptionId?: string; limit?: number } = {}): Promise<SubscriptionEvent[]> {
    const q = this.db('billing_subscription_events').where({ tenant_id: tenantId }).orderBy('at', 'desc').orderBy('seq', 'desc').limit(opts.limit ?? 200);
    if (opts.subscriptionId) q.andWhere({ subscription_id: opts.subscriptionId });
    return ((await q) as Record<string, unknown>[]).map(eventFromRow);
  }

  private tableSeen = false;

  /**
   * Whether the history table exists. A database the 124 migration has not reached yet has no subscriptions, so the
   * statement engine's reads answer "none" there instead of failing.
   */
  private async ready(): Promise<boolean> {
    if (this.tableSeen) return true;
    this.tableSeen = await this.db.schema.hasTable('billing_subscription_events');
    return this.tableSeen;
  }

  /** Every stored event of a tenant up to `until`, oldest first. */
  private async eventsUntil(tenantId: string, until: number): Promise<SubscriptionEvent[]> {
    if (!(await this.ready())) return [];
    return ((await this.db('billing_subscription_events').where({ tenant_id: tenantId }).andWhere('at', '<=', until).orderBy('at', 'asc').orderBy('recorded_at', 'asc').orderBy('seq', 'asc')) as Record<string, unknown>[]).map(eventFromRow);
  }

  // ---------- B-163 interface: what applied at a moment, and what happened over a range ----------

  /**
   * What applied to a tenant at `at` (ms), or null: no subscription then (never one, not started yet, or cancelled
   * or ended before it), so the tenant is billed by usage alone.
   */
  async at(tenantId: string, at: number): Promise<SubscriptionAtDetail | null> {
    const events = await this.eventsUntil(tenantId, at);
    const last = events.at(-1);
    if (!last) return null;
    const book = await this.book([last.snapshot]);
    const moved = project(last.snapshot, book, at);
    const snap = moved.at(-1)?.snapshot ?? last.snapshot;
    if (FINISHED.includes(snap.state)) return null;
    if (moved.length) Object.assign(book, await this.book([snap]));
    const plan = planOf(book, snap);
    if (!plan) return null;
    const { includedSeats, ...planOnly } = plan;
    const b = cycleBounds(snap.cycle, snap.startedAt, at);
    const charges = CHARGEABLE_STATES.includes(snap.state);
    return {
      subscriptionId: last.subscriptionId,
      planId: plan.id,
      planName: plan.name,
      currency: snap.currency,
      priceMinor: charges ? plan.priceMinor : 0,
      seats: snap.seats,
      includedSeats,
      seatPriceMinor: charges ? plan.seatPriceMinor : 0,
      allowances: snap.state === 'paused' ? {} : allowancesFor(book, snap),
      cycle: { ...snap.cycle },
      periodStart: b.start,
      periodEnd: b.end,
      plan: planOnly,
      planKey: plan.key,
      planVersion: plan.version,
      state: snap.state,
      trialEnd: snap.trialEnd,
      startedAt: snap.startedAt,
      cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
      cycleAmountMinor: cycleAmount(plan, includedSeats, snap.seats)
    };
  }

  /**
   * The engine's view of `[from, to)`: the stretches of a tenant's subscriptions with the same plan, seats and state,
   * cut at every change and every cycle boundary, oldest first. A stretch that does not charge (a trial, a pause) has
   * prices of 0; a paused one has no allowances. `fraction` is the stretch's whole seconds over its cycle's.
   */
  async periods(tenantId: string, from: number, to: number): Promise<SubscriptionStretch[]> {
    const out: SubscriptionStretch[] = [];
    for (const c of await this.cycleDetail(tenantId, from, to)) {
      const whole = secs(c.fullStart, c.periodEnd);
      for (const sg of c.segments) {
        const a = Math.max(sg.from, from);
        const z = Math.min(sg.to, to);
        if (!(z > a)) continue;
        const charges = CHARGEABLE_STATES.includes(sg.state);
        out.push({
          subscriptionId: c.subscriptionId,
          planId: sg.plan.id,
          planName: sg.plan.name,
          priceMinor: charges ? sg.plan.priceMinor : 0,
          seats: sg.seats,
          includedSeats: sg.includedSeats,
          seatPriceMinor: charges ? sg.plan.seatPriceMinor : 0,
          allowances: sg.state === 'paused' ? {} : { ...sg.cycleAllowances },
          cycle: { ...c.cycle },
          from: a,
          to: z,
          periodStart: c.fullStart,
          periodEnd: c.periodEnd,
          fraction: { num: secs(a, z), den: whole },
          state: sg.state,
          planKey: sg.plan.key,
          planVersion: sg.plan.version
        });
      }
    }
    return out.sort((x, y) => x.from - y.from);
  }

  /**
   * The periods of a tenant's subscriptions that overlap `[from, to)`, each with its opening (in-advance) charge,
   * the stretches over which nothing changed, and the changes inside it with their proration. Empty when the tenant
   * had no subscription then.
   */
  async cycleDetail(tenantId: string, from: number, to: number): Promise<CycleDetail[]> {
    if (!(to > from)) throw badRequest('The range ends after it starts.');
    const events = await this.eventsUntil(tenantId, to);
    if (!events.length) return [];
    const bySub = new Map<string, SubscriptionEvent[]>();
    for (const e of events) bySub.set(e.subscriptionId, [...(bySub.get(e.subscriptionId) ?? []), e]);
    const book = await this.book(events.map((e) => e.snapshot));
    const out: CycleDetail[] = [];
    for (const [subId, evs] of bySub) {
      // The timeline: the stored changes, then what time brought since the last of them, up to the range's end.
      const timeline: { at: number; kind: string; snapshot: Snapshot; eventId: string | null }[] = evs.map((e) => ({ at: e.at, kind: e.kind, snapshot: e.snapshot, eventId: e.id }));
      const last = timeline.at(-1)!;
      for (const t of project(last.snapshot, book, to)) timeline.push({ at: t.at, kind: t.kind, snapshot: t.snapshot, eventId: null });
      const extra = await this.book(timeline.map((t) => t.snapshot));
      for (const [k, v] of extra.plans) book.plans.set(k, v);
      for (const [k, v] of extra.versions) book.versions.set(k, v);
      const first = timeline[0]!.snapshot;
      const endOfLife = timeline.find((t) => FINISHED.includes(t.snapshot.state))?.at ?? Infinity;
      // Walk the periods from the one containing max(from, start).
      let t = Math.max(from, first.startedAt);
      for (let i = 0; i < MAX_STEPS && t < to && t < endOfLife; i++) {
        const p = periodAt(first.startedAt, first.cycle, t);
        const stateAt = (x: number) => {
          let cur = timeline[0]!;
          for (const e of timeline) if (e.at <= x) cur = e;
          return cur.snapshot;
        };
        const opening = stateAt(p.start);
        const whole = secs(p.fullStart, p.end);
        const plan0 = planOf(book, opening);
        if (!plan0) break;
        const { includedSeats: inc0, ...plan0Only } = plan0;
        const openAmount = chargeableAmount(book, opening);
        const segments: PeriodSegment[] = [];
        const changes: PeriodChange[] = [];
        // Only what changes the plan, its version, the seats or the state cuts a stretch (a scheduled change does not).
        const material = (e: (typeof timeline)[number]) => {
          const x = stateAt(e.at - 1);
          const y = e.snapshot;
          return x.planId !== y.planId || x.planVersion !== y.planVersion || x.seats !== y.seats || x.state !== y.state;
        };
        const inside = timeline.filter((e) => e.at > p.start && e.at < p.end && material(e));
        const cuts = [p.start, ...inside.map((e) => e.at), Math.min(p.end, endOfLife)].filter((x, idx, arr) => idx === 0 || x > arr[idx - 1]!);
        for (let k = 0; k + 1 < cuts.length; k++) {
          const a = cuts[k]!;
          const b = cuts[k + 1]!;
          const snap = stateAt(a);
          const pl = planOf(book, snap);
          if (!pl) continue;
          const { includedSeats, ...plOnly } = pl;
          const amt = chargeableAmount(book, snap);
          const part = secs(a, b);
          const allow: Partial<Record<MeterName, number>> = {};
          const full = allowancesFor(book, snap);
          if (snap.state === 'active' || snap.state === 'trialing') for (const [m, n] of Object.entries(full)) allow[m as MeterName] = Math.floor((Number(n) * part) / whole);
          segments.push({ from: a, to: b, state: snap.state, plan: plOnly, seats: snap.seats, includedSeats, fraction: part / whole, cycleAmountMinor: cycleAmount(pl, includedSeats, snap.seats), amountMinor: prorate(amt, part, whole), allowances: allow, cycleAllowances: full });
        }
        for (const e of inside) {
          if (e.kind === 'renewed') continue;
          const before = stateAt(e.at - 1);
          const after = e.snapshot;
          const pr = prorationOf(book, before, after, e.at);
          const kindOf = (): string => {
            if (e.kind === 'trial-ended' || e.kind === 'paused' || e.kind === 'resumed' || e.kind === 'cancelled' || e.kind === 'ended') return e.kind;
            const planChanged = before.planId !== after.planId || before.planVersion !== after.planVersion;
            const seatsChanged = before.seats !== after.seats;
            return planChanged && seatsChanged ? 'plan+seats' : planChanged ? 'plan' : seatsChanged ? 'seats' : e.kind;
          };
          const key = (x: Snapshot) => ({ planKey: book.plans.get(x.planId)?.key ?? x.planId, planVersion: x.planVersion, seats: x.seats, state: x.state });
          changes.push({ at: e.at, kind: kindOf(), from: key(before), to: key(after), ...pr, eventId: e.eventId });
        }
        const allowances: Partial<Record<MeterName, number>> = {};
        for (const sg of segments) for (const [m, n] of Object.entries(sg.allowances)) allowances[m as MeterName] = (allowances[m as MeterName] ?? 0) + Number(n);
        const fraction = secs(p.start, p.end) / whole;
        out.push({
          subscriptionId: subId,
          currency: opening.currency,
          cycle: { ...opening.cycle },
          periodStart: p.start,
          periodEnd: p.end,
          fullStart: p.fullStart,
          opening: { plan: plan0Only, seats: opening.seats, includedSeats: inc0, state: opening.state, cycleAmountMinor: cycleAmount(plan0, inc0, opening.seats), fraction, chargeMinor: prorate(openAmount, secs(p.start, p.end), whole) },
          segments,
          changes,
          allowances,
          final: endOfLife <= p.end
        });
        t = p.end;
      }
    }
    return out.sort((a, b) => a.periodStart - b.periodStart);
  }

  // ---------- changes ----------

  /** Writes what time brought since the last change (trial end, renewals, a scheduled cancellation) into the history. */
  async advance(sub: SubscriptionRow, now = Date.now()): Promise<SubscriptionRow> {
    if (FINISHED.includes(sub.state)) return sub;
    const book = await this.book([sub]);
    const moves = project(sub, book, now);
    if (!moves.length) return sub;
    const after = moves.at(-1)!.snapshot;
    await this.write(sub, after, moves.map((m) => ({ at: m.at, kind: m.kind, snapshot: m.snapshot, detail: m.detail })), null);
    const plan = book.plans.get(after.planId) ?? book.plans.get(sub.planId);
    for (const m of moves) await this.auditSystem(sub.tenantId, `billing.subscription.${m.kind}`, sub.id, plan?.key ?? m.snapshot.planId, { at: new Date(m.at).toISOString(), state: m.snapshot.state, seats: m.snapshot.seats, planVersion: m.snapshot.planVersion, ...m.detail });
    return (await this.byId(sub.id))!;
  }

  async byId(id: string): Promise<SubscriptionRow | null> {
    const r = await this.db('billing_subscriptions').where({ id }).first();
    return r ? rowToSub(r) : null;
  }

  /** The live subscription, moved on to now. */
  private async live(tenantId: string, now: number): Promise<SubscriptionRow> {
    const sub = await this.current(tenantId);
    if (!sub) throw notFound('Subscription');
    const moved = await this.advance(sub, now);
    if (FINISHED.includes(moved.state)) throw notFound('Subscription');
    return moved;
  }

  /** Appends history rows and updates the subscription, refusing when someone else changed it first. */
  private async write(before: SubscriptionRow, after: Snapshot, events: { at: number; kind: string; snapshot: Snapshot; detail?: Record<string, unknown> | null }[], actor: string | null): Promise<SubscriptionEvent[]> {
    const t = Date.now();
    const ids: string[] = [];
    try {
      await this.db.transaction(async (trx) => {
        const n = await trx('billing_subscriptions').where({ id: before.id, rev: before.rev }).update({ ...columnsOf(after, before.tenantId), rev: before.rev + 1, updated_at: t });
        if (!n) throw conflict('The subscription changed at the same moment; reload it and try again.');
        const top = ((await trx('billing_subscription_events').where({ subscription_id: before.id }).max({ s: 'seq' })) as { s: number | null }[])[0]?.s ?? 0;
        let seq = Number(top);
        for (const e of events) {
          const id = ulid();
          ids.push(id);
          seq += 1;
          await trx('billing_subscription_events').insert({ id, subscription_id: before.id, tenant_id: before.tenantId, seq, at: e.at, kind: e.kind, snapshot: JSON.stringify(snapshotOf(e.snapshot)), detail: e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null, actor, recorded_at: t });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('The subscription changed at the same moment; reload it and try again.');
      throw err;
    }
    return ((await this.db('billing_subscription_events').whereIn('id', ids).orderBy('seq', 'asc')) as Record<string, unknown>[]).map(eventFromRow);
  }

  private auditSystem(tenantId: string, action: string, subscriptionId: string, planKey: string, detail: Record<string, unknown>) {
    return this.s().audit.append({ tenantId, action, kind: 'system', actor: { service: 'billing' }, target: { subscription: subscriptionId, plan: planKey }, label: 'internal', detail });
  }

  private audit(by: SubscriptionActor, tenantId: string, action: string, subscriptionId: string, planKey: string, detail: Record<string, unknown>) {
    return this.s().audit.append({ tenantId, action, kind: 'admin', actor: by.actor, target: { subscription: subscriptionId, plan: planKey, tenant: tenantId }, label: 'internal', detail, ...(by.traceId ? { traceId: by.traceId } : {}) });
  }

  /** A plan a person may put a tenant on: active, with an approved version priced in the currency and cycle. */
  private async usablePlan(by: SubscriptionActor, planId: string, currency: string, months: number): Promise<{ plan: PlanRow; version: PlanVersionRow }> {
    const plan = await this.s().plans.get(planId);
    if (plan.visibility === 'private' && !by.platform) throw notFound('Plan');
    if (plan.state !== 'active') throw conflict(`${plan.name} is retired; choose another plan.`);
    if (plan.current_version == null) throw conflict(`${plan.name} has no approved prices yet.`);
    const version = await this.s().plans.version(plan.id, plan.current_version);
    if (!planAt(plan, version, currency, months)) throw conflict(`${plan.name} has no price in ${currency.toUpperCase()} for a ${months}-month cycle.`);
    return { plan, version };
  }

  async subscribe(by: SubscriptionActor, tenantId: string, input: { planId: string; seats: number; currency: string; cycle: { kind: CycleKind; months?: number; anchorDay?: number }; trialDays?: number; endsAt?: number | null }, now = Date.now()): Promise<{ subscription: SubscriptionRow; event: SubscriptionEvent }> {
    const existing = await this.current(tenantId);
    if (existing && !FINISHED.includes((await this.advance(existing, now)).state)) throw conflict('This tenant already has a subscription; change its plan instead.');
    const currency = input.currency.toUpperCase();
    const anchorDay = input.cycle.anchorDay ?? Math.min(28, new Date(now).getUTCDate());
    const cycle = cycleOf(input.cycle.kind, input.cycle.months, anchorDay);
    const { plan, version } = await this.usablePlan(by, input.planId, currency, cycle.months);
    if (input.trialDays !== undefined && !by.platform) throw forbidden('Only a platform admin sets the trial; the plan offers its own.', { step: 'role' });
    // A trial only on a tenant's first subscription, so cancelling and subscribing again starts no new one.
    const before = await this.db('billing_subscriptions').where({ tenant_id: tenantId }).first('id');
    const trialDays = input.trialDays ?? (before ? 0 : plan.trial_days);
    if (input.endsAt != null && input.endsAt <= now) throw badRequest('A fixed end is in the future.', { field: 'endsAt' });
    const p = periodAt(now, cycle, now);
    const snap: Snapshot = { planId: plan.id, planVersion: version.version, seats: input.seats, currency, state: trialDays > 0 ? 'trialing' : 'active', trialEnd: trialDays > 0 ? now + trialDays * DAY : null, startedAt: now, endsAt: input.endsAt ?? null, cycle, periodStart: p.start, periodEnd: p.end, cancelAtPeriodEnd: false, pausedAt: null, finishedAt: null, pendingChange: null };
    const id = ulid();
    try {
      await this.db.transaction(async (trx) => {
        await trx('billing_subscriptions').insert({ id, tenant_id: tenantId, ...columnsOf(snap, tenantId), rev: 0, created_by: by.userId, created_at: now, updated_at: now });
        await trx('billing_subscription_events').insert({ id: ulid(), subscription_id: id, tenant_id: tenantId, seq: 1, at: now, kind: 'created', snapshot: JSON.stringify(snap), detail: null, actor: by.userId, recorded_at: now });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('This tenant already has a subscription; change its plan instead.');
      throw err;
    }
    const book = await this.book([snap]);
    const opening = prorate(chargeableAmount(book, snap), secs(p.start, p.end), secs(p.fullStart, p.end));
    await this.audit(by, tenantId, 'billing.subscription.created', id, plan.key, { planVersion: version.version, seats: snap.seats, currency, cycle, state: snap.state, trialEnd: snap.trialEnd, endsAt: snap.endsAt, periodStart: p.start, periodEnd: p.end, openingChargeMinor: opening });
    const event = (await this.history(tenantId, { subscriptionId: id, limit: 1 }))[0]!;
    return { subscription: (await this.byId(id))!, event };
  }

  /** What a plan or seat change would do, without doing it. */
  async preview(by: SubscriptionActor, tenantId: string, input: { planId?: string; seats?: number; when: 'now' | 'renewal' }, now = Date.now()) {
    const sub = await this.current(tenantId);
    if (!sub) throw notFound('Subscription');
    const book = await this.book([sub]);
    const cur = project(sub, book, now).at(-1)?.snapshot ?? sub;
    if (FINISHED.includes(cur.state)) throw notFound('Subscription');
    const after = await this.changed(by, cur, input, now);
    const bk = await this.book([cur, after]);
    if (input.when === 'renewal') {
      const renewal = project({ ...cur, pendingChange: { planId: after.planId, planVersion: after.planVersion, seats: after.seats } }, bk, cur.periodEnd).find((t) => t.kind === 'renewed');
      const next = renewal?.snapshot ?? after;
      return { when: 'renewal' as const, at: cur.periodEnd, before: this.quoteView(bk, cur), after: this.quoteView(bk, next), creditMinor: 0, chargeMinor: 0, netMinor: 0, remainingSeconds: 0, periodSeconds: secs(periodAt(cur.startedAt, cur.cycle, now).fullStart, cur.periodEnd), nextCycleAmountMinor: chargeableAmount(bk, { ...next, state: next.state === 'trialing' ? 'active' : next.state }) };
    }
    const pr = prorationOf(bk, cur, after, now);
    return { when: 'now' as const, at: now, before: this.quoteView(bk, cur), after: this.quoteView(bk, after), ...pr, nextCycleAmountMinor: chargeableAmount(bk, { ...after, state: after.state === 'trialing' ? 'active' : after.state }) };
  }

  private quoteView(book: PlanBook, s: Snapshot) {
    const p = planOf(book, s);
    return { planId: s.planId, planKey: book.plans.get(s.planId)?.key ?? null, planName: book.plans.get(s.planId)?.name ?? null, planVersion: s.planVersion, seats: s.seats, includedSeats: p?.includedSeats ?? 0, state: s.state, cycleAmountMinor: p ? cycleAmount(p, p.includedSeats, s.seats) : 0, currency: s.currency };
  }

  /** The snapshot after a plan or seat change at `now` (the newest approved version of a new plan). */
  private async changed(by: SubscriptionActor, cur: Snapshot, input: { planId?: string; seats?: number }, now: number): Promise<Snapshot> {
    if (input.planId === undefined && input.seats === undefined) throw badRequest('Name a plan or a number of seats.');
    if (cur.state === 'paused') throw conflict('The subscription is paused; resume it before changing it.');
    let planId = cur.planId;
    let planVersion = cur.planVersion;
    if (input.planId !== undefined && input.planId !== cur.planId) {
      const { plan, version } = await this.usablePlan(by, input.planId, cur.currency, cur.cycle.months);
      planId = plan.id;
      planVersion = version.version;
    }
    const seats = input.seats ?? cur.seats;
    if (planId === cur.planId && seats === cur.seats) throw conflict('That is the plan and number of seats already in force.');
    void now;
    return { ...cur, planId, planVersion, seats };
  }

  /** Changes the plan or seats, now (prorated) or at renewal (scheduled). */
  async change(by: SubscriptionActor, tenantId: string, input: { planId?: string; seats?: number; when: 'now' | 'renewal' }, now = Date.now()): Promise<{ subscription: SubscriptionRow; event: SubscriptionEvent; proration: ReturnType<typeof prorationOf> | null }> {
    const sub = await this.live(tenantId, now);
    const after = await this.changed(by, sub, input, now);
    const bk = await this.book([sub, after]);
    const planKey = (id: string) => bk.plans.get(id)?.key ?? id;
    if (input.when === 'renewal') {
      const snap = { ...snapshotOf(sub), pendingChange: { planId: after.planId, planVersion: after.planVersion, seats: after.seats } };
      const [event] = await this.write(sub, snap, [{ at: now, kind: 'change-scheduled', snapshot: snap, detail: { planId: after.planId, seats: after.seats, at: sub.periodEnd } }], by.userId);
      await this.audit(by, tenantId, 'billing.subscription.change-scheduled', sub.id, planKey(sub.planId), { from: { plan: planKey(sub.planId), seats: sub.seats }, to: { plan: planKey(after.planId), seats: after.seats }, at: new Date(sub.periodEnd).toISOString() });
      return { subscription: (await this.byId(sub.id))!, event: event!, proration: null };
    }
    const pr = prorationOf(bk, sub, after, now);
    const snap = { ...snapshotOf(after), pendingChange: null };
    const kind = sub.planId !== after.planId ? 'plan-changed' : 'seats-changed';
    const [event] = await this.write(sub, snap, [{ at: now, kind, snapshot: snap, detail: { ...pr, from: { planId: sub.planId, planVersion: sub.planVersion, seats: sub.seats }, to: { planId: after.planId, planVersion: after.planVersion, seats: after.seats } } }], by.userId);
    await this.audit(by, tenantId, `billing.subscription.${kind}`, sub.id, planKey(after.planId), { from: { plan: planKey(sub.planId), version: sub.planVersion, seats: sub.seats }, to: { plan: planKey(after.planId), version: after.planVersion, seats: after.seats }, ...pr, rounding: 'half away from zero, per amount' });
    return { subscription: (await this.byId(sub.id))!, event: event!, proration: pr };
  }

  async unschedule(by: SubscriptionActor, tenantId: string, now = Date.now()): Promise<SubscriptionRow> {
    const sub = await this.live(tenantId, now);
    if (!sub.pendingChange) throw conflict('No change is scheduled.');
    const snap = { ...snapshotOf(sub), pendingChange: null };
    await this.write(sub, snap, [{ at: now, kind: 'change-unscheduled', snapshot: snap, detail: { was: sub.pendingChange } }], by.userId);
    await this.audit(by, tenantId, 'billing.subscription.change-unscheduled', sub.id, sub.planId, { was: sub.pendingChange });
    return (await this.byId(sub.id))!;
  }

  /** Cancels at the period's end (undone with `keep`), or now: the rest of the period is credited. */
  async cancel(by: SubscriptionActor, tenantId: string, when: 'period-end' | 'now', now = Date.now()): Promise<{ subscription: SubscriptionRow; proration: ReturnType<typeof prorationOf> | null }> {
    const sub = await this.live(tenantId, now);
    const bk = await this.book([sub]);
    const planKey = bk.plans.get(sub.planId)?.key ?? sub.planId;
    if (when === 'period-end') {
      if (sub.cancelAtPeriodEnd) throw conflict('The subscription already ends at the end of this period.');
      const snap = { ...snapshotOf(sub), cancelAtPeriodEnd: true, pendingChange: null };
      await this.write(sub, snap, [{ at: now, kind: 'cancel-scheduled', snapshot: snap, detail: { at: sub.periodEnd } }], by.userId);
      await this.audit(by, tenantId, 'billing.subscription.cancel-scheduled', sub.id, planKey, { at: new Date(sub.periodEnd).toISOString() });
      return { subscription: (await this.byId(sub.id))!, proration: null };
    }
    const snap: Snapshot = { ...snapshotOf(sub), state: 'cancelled', finishedAt: now, pausedAt: null, pendingChange: null };
    const pr = prorationOf(bk, sub, snap, now);
    await this.write(sub, snap, [{ at: now, kind: 'cancelled', snapshot: snap, detail: { ...pr } }], by.userId);
    await this.audit(by, tenantId, 'billing.subscription.cancelled', sub.id, planKey, { ...pr, immediate: true });
    return { subscription: (await this.byId(sub.id))!, proration: pr };
  }

  async keep(by: SubscriptionActor, tenantId: string, now = Date.now()): Promise<SubscriptionRow> {
    const sub = await this.live(tenantId, now);
    if (!sub.cancelAtPeriodEnd) throw conflict('The subscription is not set to end.');
    const snap = { ...snapshotOf(sub), cancelAtPeriodEnd: false };
    await this.write(sub, snap, [{ at: now, kind: 'cancel-unscheduled', snapshot: snap }], by.userId);
    await this.audit(by, tenantId, 'billing.subscription.cancel-unscheduled', sub.id, sub.planId, {});
    return (await this.byId(sub.id))!;
  }

  /** Pauses an active subscription: the plan stops charging (the rest of the period is credited) until it resumes. */
  async pause(by: SubscriptionActor, tenantId: string, now = Date.now()): Promise<{ subscription: SubscriptionRow; proration: ReturnType<typeof prorationOf> }> {
    const sub = await this.live(tenantId, now);
    if (sub.state !== 'active') throw conflict(`A ${sub.state} subscription cannot be paused.`);
    const bk = await this.book([sub]);
    const snap: Snapshot = { ...snapshotOf(sub), state: 'paused', pausedAt: now };
    const pr = prorationOf(bk, sub, snap, now);
    await this.write(sub, snap, [{ at: now, kind: 'paused', snapshot: snap, detail: { ...pr } }], by.userId);
    await this.audit(by, tenantId, 'billing.subscription.paused', sub.id, bk.plans.get(sub.planId)?.key ?? sub.planId, { ...pr });
    return { subscription: (await this.byId(sub.id))!, proration: pr };
  }

  async resume(by: SubscriptionActor, tenantId: string, now = Date.now()): Promise<{ subscription: SubscriptionRow; proration: ReturnType<typeof prorationOf> }> {
    const sub = await this.live(tenantId, now);
    if (sub.state !== 'paused') throw conflict('The subscription is not paused.');
    const bk = await this.book([sub]);
    const snap: Snapshot = { ...snapshotOf(sub), state: 'active', pausedAt: null };
    const pr = prorationOf(bk, sub, snap, now);
    await this.write(sub, snap, [{ at: now, kind: 'resumed', snapshot: snap, detail: { ...pr, pausedFor: sub.pausedAt != null ? now - sub.pausedAt : null } }], by.userId);
    await this.audit(by, tenantId, 'billing.subscription.resumed', sub.id, bk.plans.get(sub.planId)?.key ?? sub.planId, { ...pr });
    return { subscription: (await this.byId(sub.id))!, proration: pr };
  }

  // ---------- the tick ----------

  /** Tenants with a live subscription that time has moved on (the schedule's targets). */
  async dueTenants(now = Date.now()): Promise<{ tenantId: string }[]> {
    const rows = (await this.db('billing_subscriptions')
      .whereNotNull('live_tenant')
      .andWhere((w) => w.where('period_end', '<=', now).orWhere((x) => x.where({ state: 'trialing' }).andWhere('trial_end', '<=', now)).orWhere((x) => x.whereNotNull('ends_at').andWhere('ends_at', '<=', now)))
      .select('tenant_id')) as { tenant_id: string }[];
    return rows.map((r) => ({ tenantId: r.tenant_id }));
  }

  /** The `billing.subscriptions.tick` job for one tenant. */
  async tick(tenantId: string, now = Date.now()): Promise<{ moved: number; state: SubscriptionState | null }> {
    const sub = await this.current(tenantId);
    if (!sub) return { moved: 0, state: null };
    const before = sub.rev;
    const after = await this.advance(sub, now);
    return { moved: after.rev - before, state: after.state };
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('billing.subscriptions.tick', async (p, ctx) => this.tick(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every('billing.subscriptions.tick', 15 * 60_000, () => this.dueTenants());
  }
}

export const subscriptionView = (sub: SubscriptionRow, book: PlanBook) => {
  const p = planOf(book, sub);
  const plan = book.plans.get(sub.planId);
  const pending = sub.pendingChange ? book.plans.get(sub.pendingChange.planId) : null;
  return {
    id: sub.id,
    tenantId: sub.tenantId,
    plan: { id: sub.planId, key: plan?.key ?? null, name: plan?.name ?? null, version: sub.planVersion },
    seats: sub.seats,
    includedSeats: p?.includedSeats ?? 0,
    currency: sub.currency,
    state: sub.state,
    trialEnd: sub.trialEnd,
    startedAt: sub.startedAt,
    endsAt: sub.endsAt,
    cycle: sub.cycle,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    pausedAt: sub.pausedAt,
    finishedAt: sub.finishedAt,
    pendingChange: sub.pendingChange ? { planId: sub.pendingChange.planId, planKey: pending?.key ?? null, planName: pending?.name ?? null, seats: sub.pendingChange.seats, at: sub.periodEnd } : null,
    cycleAmountMinor: p ? cycleAmount(p, p.includedSeats, sub.seats) : 0,
    priceMinor: p?.priceMinor ?? 0,
    seatPriceMinor: p?.seatPriceMinor ?? 0,
    updatedAt: sub.updatedAt
  };
};

export const eventView = (e: SubscriptionEvent) => ({ id: e.id, seq: e.seq, at: e.at, kind: e.kind, state: e.snapshot.state, planId: e.snapshot.planId, planVersion: e.snapshot.planVersion, seats: e.snapshot.seats, detail: e.detail, actor: e.actor, recordedAt: e.recordedAt });
