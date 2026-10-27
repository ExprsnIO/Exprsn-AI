import { ulid } from 'ulid';
import { z } from 'zod';
import { json } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import type { AuditActor } from '../audit/chain.js';
import { permissionsFor } from '../authz/permissions.js';
import { conflict, forbidden, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { Meter } from './service.js';

type MeterName = Meter;

/** The plan as one subscription uses it at a moment: the catalogue version in force for it, in its currency. */
export interface PlanAt {
  id: string;
  key: string;
  name: string;
  /** The catalogue version the subscription is priced by (a new version reaches a subscriber at its next renewal). */
  version: number;
  /** The list price of one whole cycle, before seats, and of one seat beyond the included ones. */
  priceMinor: number;
  seatPriceMinor: number;
  entitlements: Record<string, boolean | number | string>;
}

/*
 * 1.9.0, Sprint 51 (B-162): the plan catalogue. Plans are platform-wide and kept by platform admins (`platform:manage`).
 *
 * A plan's name, description, visibility, state and trial length change at once (audited). What it charges and
 * includes (prices, allowances, entitlements) changes only through a version that a second platform admin approves
 * (dual control, as for custom roles): a new plan has no version in force, and cannot be subscribed to, until its
 * first version is approved. Approved versions are never changed; they are the plan's price history, and a subscriber
 * moves to a newer version at its next renewal.
 */

export const METER_NAMES = ['prompt_tokens', 'output_tokens', 'thinking_tokens', 'gpu_seconds', 'requests', 'calc_calls'] as const satisfies readonly MeterName[];

/** Minor units: a whole number, at most 10^12 (ten billion dollars in cents). */
const minor = z.number().int().min(0).max(1e12);

export const priceSchema = z
  .object({
    currency: z.string().regex(/^[A-Za-z]{3}$/).transform((c) => c.toUpperCase()),
    /** The cycle length this price is for, in months (1 monthly, 3 quarterly, 12 annual, or a custom 1 to 36). */
    months: z.number().int().min(1).max(36),
    priceMinor: minor,
    seatPriceMinor: minor.default(0),
    includedSeats: z.number().int().min(0).max(1_000_000).default(0)
  })
  .strict();
export type PlanPrice = z.infer<typeof priceSchema>;

/** Included usage per meter per month (a quarterly cycle includes three times as much). */
export const allowancesSchema = z.partialRecord(z.enum(METER_NAMES), z.number().int().min(0).max(1e15)).default({});

/**
 * Entitlements: a closed key-value list for feature flags (B-168): flat, at most 50 keys of a fixed spelling, each a
 * boolean, a whole number or a short string. Nothing nested, so a flag reads one value.
 */
export const entitlementsSchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/, 'an entitlement key is lower case: letters, digits, _ . -'), z.union([z.boolean(), z.number().int().min(-1e12).max(1e12), z.string().max(200)]))
  .refine((o) => Object.keys(o).length <= 50, 'at most 50 entitlements')
  .default({});

export const versionInputSchema = z
  .object({
    prices: z
      .array(priceSchema)
      .min(1)
      .max(60)
      .refine((ps) => new Set(ps.map((p) => `${p.currency}:${p.months}`)).size === ps.length, 'one price per currency and cycle length'),
    allowances: allowancesSchema,
    entitlements: entitlementsSchema
  })
  .strict();
export type PlanVersionInput = z.infer<typeof versionInputSchema>;

export type PlanVisibility = 'visible' | 'private';
export type PlanState = 'active' | 'retired';
export type VersionState = 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface PlanRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: PlanVisibility;
  state: PlanState;
  trial_days: number;
  current_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_by: string | null;
  updated_at: number;
}

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  version: number;
  prices: PlanPrice[];
  allowances: Partial<Record<MeterName, number>>;
  entitlements: Record<string, boolean | number | string>;
  state: VersionState;
  proposed_by: string | null;
  proposed_at: number;
  decided_by: string | null;
  decided_at: number | null;
  note: string | null;
  effective_from: number | null;
}

/** Who acts: enough for the audit entry and the dual-control check. */
export interface PlanActor {
  tenantId: string;
  userId: string;
  actor: AuditActor;
  traceId?: string;
}

const planFromRow = (r: Record<string, unknown>): PlanRow => ({
  ...(r as unknown as PlanRow),
  trial_days: Number(r.trial_days ?? 0),
  current_version: r.current_version == null ? null : Number(r.current_version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const versionFromRow = (r: Record<string, unknown>): PlanVersionRow => ({
  ...(r as unknown as PlanVersionRow),
  version: Number(r.version),
  prices: json<PlanPrice[]>(r.prices, []),
  allowances: json<Partial<Record<MeterName, number>>>(r.allowances, {}),
  entitlements: json<Record<string, boolean | number | string>>(r.entitlements, {}),
  proposed_at: Number(r.proposed_at),
  decided_at: r.decided_at == null ? null : Number(r.decided_at),
  effective_from: r.effective_from == null ? null : Number(r.effective_from)
});

/**
 * The price of a cycle of `months` in `currency`: the plan's price for that cycle length, else its one-month price
 * times the months, else none.
 */
export function priceOf(v: Pick<PlanVersionRow, 'prices'>, currency: string, months: number): { priceMinor: number; seatPriceMinor: number; includedSeats: number } | null {
  const cur = currency.toUpperCase();
  const exact = v.prices.find((p) => p.currency === cur && p.months === months);
  if (exact) return { priceMinor: exact.priceMinor, seatPriceMinor: exact.seatPriceMinor, includedSeats: exact.includedSeats };
  const monthly = v.prices.find((p) => p.currency === cur && p.months === 1);
  if (monthly) return { priceMinor: monthly.priceMinor * months, seatPriceMinor: monthly.seatPriceMinor * months, includedSeats: monthly.includedSeats };
  return null;
}

/** A plan version as a subscription uses it, in one currency and cycle length (null when it has no price for them). */
export function planAt(plan: Pick<PlanRow, 'id' | 'key' | 'name'>, v: PlanVersionRow, currency: string, months: number): (PlanAt & { includedSeats: number }) | null {
  const p = priceOf(v, currency, months);
  if (!p) return null;
  return { id: plan.id, key: plan.key, name: plan.name, version: v.version, priceMinor: p.priceMinor, seatPriceMinor: p.seatPriceMinor, includedSeats: p.includedSeats, entitlements: v.entitlements };
}

/** The cycle amount at a plan and a number of seats. */
export const cycleAmount = (p: Pick<PlanAt, 'priceMinor' | 'seatPriceMinor'>, includedSeats: number, seats: number): number => p.priceMinor + p.seatPriceMinor * Math.max(0, seats - includedSeats);

const summary = (v: Pick<PlanVersionRow, 'prices' | 'allowances' | 'entitlements'>) => ({
  prices: v.prices.map((p) => `${p.currency}/${p.months}m ${p.priceMinor}+${p.seatPriceMinor}×seat (${p.includedSeats} incl.)`),
  allowances: v.allowances,
  entitlements: Object.keys(v.entitlements)
});

export class PlanCatalogue {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async list(opts: { includePrivate?: boolean; includeRetired?: boolean } = {}): Promise<PlanRow[]> {
    const q = this.db('billing_plans').orderBy('name', 'asc');
    if (!opts.includePrivate) q.where({ visibility: 'visible' });
    if (!opts.includeRetired) q.where({ state: 'active' });
    return ((await q) as Record<string, unknown>[]).map(planFromRow);
  }

  async get(id: string): Promise<PlanRow> {
    const r = await this.db('billing_plans').where({ id }).first();
    if (!r) throw notFound('Plan');
    return planFromRow(r);
  }

  async versions(planId: string): Promise<PlanVersionRow[]> {
    return ((await this.db('billing_plan_versions').where({ plan_id: planId }).orderBy('version', 'asc')) as Record<string, unknown>[]).map(versionFromRow);
  }

  async version(planId: string, version: number): Promise<PlanVersionRow> {
    const r = await this.db('billing_plan_versions').where({ plan_id: planId, version }).first();
    if (!r) throw notFound('Plan version');
    return versionFromRow(r);
  }

  /** The approved versions of some plans, oldest first: what the subscription history is priced from. */
  async approvedOf(planIds: readonly string[]): Promise<Map<string, PlanVersionRow[]>> {
    const out = new Map<string, PlanVersionRow[]>();
    if (!planIds.length) return out;
    const rows = (await this.db('billing_plan_versions').whereIn('plan_id', [...new Set(planIds)]).andWhere({ state: 'approved' }).orderBy('version', 'asc')) as Record<string, unknown>[];
    for (const r of rows.map(versionFromRow)) out.set(r.plan_id, [...(out.get(r.plan_id) ?? []), r]);
    return out;
  }

  /** The version in force for new subscriptions at `at`: the last approved before it. */
  static inForce(versions: readonly PlanVersionRow[], at: number): PlanVersionRow | null {
    return versions.filter((v) => v.state === 'approved' && (v.effective_from ?? 0) <= at).at(-1) ?? null;
  }

  /** The platform admins (holders of platform:manage) of a tenant, for the dual-control notice. */
  private async platformAdmins(tenantId: string): Promise<string[]> {
    const rows = (await this.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).select('u.id', 'r.role')) as { id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of rows) roles.set(r.id, [...(roles.get(r.id) ?? []), r.role]);
    return [...roles].filter(([, list]) => permissionsFor(list, tenantId).has('platform:manage')).map(([id]) => id);
  }

  private audit(by: PlanActor, action: string, plan: Pick<PlanRow, 'id' | 'key' | 'name'>, detail: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: 'admin', actor: by.actor, target: { plan: plan.id, key: plan.key, name: plan.name }, label: 'internal', detail, ...(by.traceId ? { traceId: by.traceId } : {}) });
  }

  private async notifySecond(by: PlanActor, plan: PlanRow, version: number): Promise<void> {
    const s = this.s();
    const to = (await this.platformAdmins(by.tenantId)).filter((id) => id !== by.userId);
    if (!to.length) return;
    await s.notifications
      .notify({ tenantId: by.tenantId, userIds: to, kind: 'billing.plan', title: `${plan.name}: version ${version} waits for a second platform admin`, body: 'A change to what the plan charges or includes needs another platform admin to approve it.', route: 'billing-plans', label: 'internal' })
      .catch((err: unknown) => s.log.warn({ err }, 'plan proposal notice failed'));
  }

  async create(by: PlanActor, input: { key: string; name: string; description?: string | null; visibility: PlanVisibility; trialDays: number } & PlanVersionInput): Promise<{ plan: PlanRow; version: PlanVersionRow }> {
    const id = ulid();
    const t = Date.now();
    try {
      await this.db.transaction(async (trx) => {
        await trx('billing_plans').insert({ id, key: input.key, name: input.name, description: input.description ?? null, visibility: input.visibility, state: 'active', trial_days: input.trialDays, current_version: null, created_by: by.userId, created_at: t, updated_by: by.userId, updated_at: t });
        await trx('billing_plan_versions').insert({ id: ulid(), plan_id: id, version: 1, prices: JSON.stringify(input.prices), allowances: JSON.stringify(input.allowances), entitlements: JSON.stringify(input.entitlements), state: 'pending', proposed_by: by.userId, proposed_at: t });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A plan with the key ${input.key} already exists.`);
      throw err;
    }
    const plan = await this.get(id);
    const version = await this.version(id, 1);
    await this.audit(by, 'billing.plan.created', plan, { visibility: plan.visibility, trialDays: plan.trial_days, version: 1, ...summary(version), dualControl: true });
    await this.notifySecond(by, plan, 1);
    return { plan, version };
  }

  /** Changes what does not affect a price: name, description, visibility, state, trial length. */
  async update(by: PlanActor, id: string, patch: { name?: string; description?: string | null; visibility?: PlanVisibility; state?: PlanState; trialDays?: number }): Promise<{ before: PlanRow; after: PlanRow }> {
    const before = await this.get(id);
    const upd: Record<string, unknown> = { updated_by: by.userId, updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.visibility !== undefined) upd.visibility = patch.visibility;
    if (patch.state !== undefined) upd.state = patch.state;
    if (patch.trialDays !== undefined) upd.trial_days = patch.trialDays;
    await this.db('billing_plans').where({ id }).update(upd);
    const after = await this.get(id);
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    await this.audit(by, after.state === 'retired' && before.state !== 'retired' ? 'billing.plan.retired' : 'billing.plan.updated', after, { changed, before: { name: before.name, visibility: before.visibility, state: before.state, trialDays: before.trial_days }, after: { name: after.name, visibility: after.visibility, state: after.state, trialDays: after.trial_days } });
    return { before, after };
  }

  /** Proposes new prices, allowances or entitlements; one proposal waits per plan at a time. */
  async propose(by: PlanActor, id: string, input: PlanVersionInput): Promise<PlanVersionRow> {
    const plan = await this.get(id);
    if (await this.db('billing_plan_versions').where({ plan_id: id, state: 'pending' }).first()) throw conflict('A change to this plan already waits for approval; approve, reject or withdraw it first.');
    const last = ((await this.db('billing_plan_versions').where({ plan_id: id }).max({ v: 'version' })) as { v: number | null }[])[0]?.v ?? 0;
    const version = Number(last) + 1;
    try {
      await this.db('billing_plan_versions').insert({ id: ulid(), plan_id: id, version, prices: JSON.stringify(input.prices), allowances: JSON.stringify(input.allowances), entitlements: JSON.stringify(input.entitlements), state: 'pending', proposed_by: by.userId, proposed_at: Date.now() });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Someone proposed a change to this plan at the same moment; reload it.');
      throw err;
    }
    const v = await this.version(id, version);
    const current = plan.current_version != null ? await this.version(id, plan.current_version) : null;
    await this.audit(by, 'billing.plan.proposed', plan, { version, before: current ? summary(current) : null, after: summary(v), dualControl: true });
    await this.notifySecond(by, plan, version);
    return v;
  }

  /** Dual control: another platform admin puts a pending version in force, from now. */
  async approve(by: PlanActor, id: string, version: number, note: string | null): Promise<{ plan: PlanRow; version: PlanVersionRow }> {
    const plan = await this.get(id);
    const v = await this.version(id, version);
    if (v.state !== 'pending') throw conflict(`Version ${version} is ${v.state}.`);
    if (v.proposed_by && v.proposed_by === by.userId) throw forbidden('Dual control: you cannot approve your own change. Another platform admin must approve it.', { step: 'dual-control' });
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      // Claim first, so two approvers racing put it in force once.
      const n = await trx('billing_plan_versions').where({ id: v.id, state: 'pending' }).update({ state: 'approved', decided_by: by.userId, decided_at: t, note, effective_from: t });
      if (!n) throw conflict('The version was decided by someone else.');
      await trx('billing_plans').where({ id }).update({ current_version: version, updated_by: by.userId, updated_at: t });
    });
    const after = await this.version(id, version);
    await this.audit(by, 'billing.plan.approved', plan, { version, proposedBy: v.proposed_by, note, first: plan.current_version == null, ...summary(after) });
    return { plan: await this.get(id), version: after };
  }

  /** Rejects a pending version; its proposer withdraws it instead. */
  async reject(by: PlanActor, id: string, version: number, note: string | null): Promise<PlanVersionRow> {
    const plan = await this.get(id);
    const v = await this.version(id, version);
    if (v.state !== 'pending') throw conflict(`Version ${version} is ${v.state}.`);
    const state: VersionState = v.proposed_by === by.userId ? 'withdrawn' : 'rejected';
    const n = await this.db('billing_plan_versions').where({ id: v.id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('The version was decided by someone else.');
    await this.audit(by, state === 'withdrawn' ? 'billing.plan.withdrawn' : 'billing.plan.rejected', plan, { version, proposedBy: v.proposed_by, note });
    return this.version(id, version);
  }
}

export const planVersionView = (v: PlanVersionRow) => ({
  version: v.version,
  state: v.state,
  prices: v.prices,
  allowances: v.allowances,
  entitlements: v.entitlements,
  proposedBy: v.proposed_by,
  proposedAt: v.proposed_at,
  decidedBy: v.decided_by,
  decidedAt: v.decided_at,
  note: v.note,
  effectiveFrom: v.effective_from
});

export const planView = (p: PlanRow, current: PlanVersionRow | null, pending?: PlanVersionRow | null) => ({
  id: p.id,
  key: p.key,
  name: p.name,
  description: p.description,
  visibility: p.visibility,
  state: p.state,
  trialDays: p.trial_days,
  currentVersion: p.current_version,
  subscribable: p.state === 'active' && p.current_version != null,
  current: current ? planVersionView(current) : null,
  ...(pending !== undefined ? { pending: pending ? planVersionView(pending) : null } : {}),
  updatedAt: p.updated_at
});
