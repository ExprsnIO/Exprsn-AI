/*
 * 1.9.0, Sprint 51 (B-163 to B-166): the statement line model and the seams between the statement engine
 * (`billing/service.ts`, `engine.ts`, `tiers.ts`, `discounts.ts`) and plans and subscriptions (B-162), the PDF and
 * the Stripe lines (B-166). This file has types and documentation only, so either side may import it.
 *
 * Money
 * -----
 * Every amount is an integer. Statement amounts are in micros (millionths of the currency unit), as
 * `billing_statements.total_micros` has always been; inputs that people type (plan and seat prices, a fixed discount,
 * a cap or threshold) are in the currency's minor units (cents; none for JPY and the other zero-decimal currencies,
 * see `minorDigits`). Where a fraction arises the rounding is stated next to it:
 *
 * - A usage line of a monthly statement (no subscription, no discount, flat prices only) is rounded half up to the
 *   micro, exactly as before 1.9.0.
 * - Every charge line of a cycle statement is rounded to a whole minor unit, half away from zero, once, when the line
 *   is made; the totals are sums of those lines, so the statement, the PDF and the Stripe invoice agree to the cent.
 * - Proration multiplies a price by an exact fraction (`Fraction`, integers) and rounds the product, never a
 *   floating-point share.
 */
import type { Meter } from './service.js';

// ---------- cycles (B-163) ----------

export type CycleKind = 'monthly' | 'quarterly' | 'annual' | 'custom';

/**
 * A billing cycle: `months` long (1, 3, 12, or any number from 1 to 36 for `custom`), starting on `anchorDay` (1 to
 * 31) of the month, at 00:00 UTC. In a month shorter than the anchor, the cycle starts on the month's last day (an
 * anchor of 31 gives 28 February, then 31 March).
 */
export interface Cycle {
  kind: CycleKind;
  months: number;
  anchorDay: number;
}

/** A statement made before 1.9.0, or for a tenant with no subscription: one calendar month. */
export const CALENDAR_MONTH: Cycle = { kind: 'monthly', months: 1, anchorDay: 1 };

/** An exact share, `num / den`, both non-negative integers, `den > 0`. */
export interface Fraction {
  num: number;
  den: number;
}

// ---------- the subscription seam (B-162, Agent P) ----------

/**
 * What the statement engine needs from a tenant's subscription at one moment. `s.subscriptions.at(tenantId, at)`
 * returns it, or null when the tenant has no live subscription then (never subscribed, cancelled, before its start).
 * Prices are in minor units of `currency` and are per cycle; allowances are units of each meter included per cycle.
 */
export interface SubscriptionAt {
  subscriptionId: string;
  planId: string;
  planName: string;
  currency: string;
  /** The plan's price for one whole cycle, in minor units. */
  priceMinor: number;
  seats: number;
  includedSeats: number;
  /** The price of one seat above `includedSeats` for one whole cycle, in minor units. */
  seatPriceMinor: number;
  allowances: Partial<Record<Meter, number>>;
  cycle: Cycle;
  /** The cycle containing `at` (ms, UTC; end exclusive). */
  periodStart: number;
  periodEnd: number;
}

/**
 * One stretch of a subscription with the same plan and seats, within `[from, to)` asked of `periods`. A plan or seat
 * change in the middle of a cycle ends one period and starts the next; a cycle boundary does too. `fraction` is the
 * share of its cycle the period covers (for example `{ num: 15, den: 30 }` by days, or milliseconds); when it is left
 * out the engine uses `(to - from) / (periodEnd - periodStart)` in milliseconds.
 */
export interface SubscriptionPeriod {
  subscriptionId: string;
  planId: string;
  planName: string;
  priceMinor: number;
  seats: number;
  includedSeats: number;
  seatPriceMinor: number;
  allowances: Partial<Record<Meter, number>>;
  cycle: Cycle;
  from: number;
  to: number;
  /** The cycle this period belongs to. */
  periodStart: number;
  periodEnd: number;
  fraction?: Fraction;
}

/**
 * The narrow interface the statement engine reads subscriptions through. Until B-162 lands, `BillingService` uses
 * `NO_SUBSCRIPTIONS`, so every tenant keeps its monthly statements; `BillingService.useSubscriptions(source)` (or a
 * `subscriptions` member of `Services` with these two methods) switches it.
 */
export interface SubscriptionSource {
  at(tenantId: string, at: number): Promise<SubscriptionAt | null>;
  /** The subscribed stretches within `[from, to)`, oldest first, without gaps inside a stretch. */
  periods(tenantId: string, from: number, to: number): Promise<SubscriptionPeriod[]>;
}

export const NO_SUBSCRIPTIONS: SubscriptionSource = {
  at: async () => null,
  periods: async () => []
};

// ---------- tiered pricing (B-164) ----------

/**
 * How a price book item prices a cycle's quantity of its meter. Prices are in micros per `perUnits` units of the
 * item, as flat items always were.
 *
 * - `flat` (the default, and every item from before 1.9.0): `quantity × unitPriceMicros / perUnits`.
 * - `graduated`: each tier prices the units that fall in it (the first 1,000,000 at one price, the next at another).
 * - `volume`: the tier the cycle's whole quantity reaches prices every unit.
 * - `package`: `unitPriceMicros` per block of `perUnits` units, a part block rounded up to a whole one.
 *
 * Tier bounds are inclusive: a quantity of exactly `upTo` is in that tier. The last tier has `upTo: null`.
 */
export type PricingModel = 'flat' | 'graduated' | 'volume' | 'package';

export interface PriceTier {
  /** The last unit in this tier (inclusive), or null for no upper bound (the last tier). */
  upTo: number | null;
  /** Micros per `perUnits` units in this tier. */
  unitPriceMicros: number;
  /** A fixed amount for reaching this tier (graduated: once if any unit falls in it; volume: once). */
  flatMicros?: number;
}

// ---------- the statement line (B-163 to B-166) ----------

export type ChargeKind = 'plan' | 'seats' | 'proration' | 'usage' | 'discount' | 'credit' | 'tax';

/**
 * One line of a statement as `compute` makes it and `billing_statements.charges` keeps it; the PDF and the Stripe
 * invoice items are built from these lines and nothing else. The statement's totals are sums of them:
 *
 *   subtotal = Σ amount of plan, seats, proration, usage and discount lines   (discounts are negative)
 *   tax      = Σ amount of tax lines (each a rate of the subtotal, so tax applies after discounts)
 *   total    = subtotal + tax
 *
 * `credit` lines are credit notes issued against the invoice after it was sent (from the provider's events); they
 * are shown on the statement but are not part of `total` (the balance is `total - credited - refunded`). The engine
 * never makes one when it computes.
 *
 * - `plan`: the plan for the cycle, in advance (`timing: 'advance'`), from when the subscription covers the cycle.
 * - `seats`: seats above the plan's included seats, in advance.
 * - `proration`: a mid-cycle plan or seat change: a credit (negative) for the unused part of the old plan or seats,
 *   then a charge for the new ones, each for the rest of the cycle.
 * - `usage`: a meter's usage beyond the plan's allowances, in arrears, by price book item and segment (one line per
 *   tier for graduated pricing), plus minimum (positive) and cap (negative) adjustments with `tier: 'minimum'`/`'cap'`.
 * - `discount`: one line per discount rule applied (negative), in stacking order, `ruleId` naming the rule.
 * - `tax`: one line per tax rate, on the subtotal.
 */
export interface ChargeLine {
  kind: ChargeKind;
  description: string;
  /** Units of `unit` (seats, tokens, blocks, or 1 for a plan); may be fractional for GPU-seconds. */
  quantity: number;
  /** What `quantity` counts and what `unitAmount` is per: `cycle`, `seat`, `1000000 prompt tokens`, `block of 1000 requests`, `percent`… */
  unit: string;
  /** Micros per `unit`; for a percentage discount or tax, the rate in parts per million. */
  unitAmount: number;
  /** Micros; negative for credits and discounts. In a cycle statement, a whole number of minor units. */
  amount: number;
  meter?: Meter;
  /** A tier's 1-based number, or `minimum` / `cap` for a cycle's minimum and cap adjustments. */
  tier?: number | 'minimum' | 'cap';
  ruleId?: string;
  /** When the line is charged: plan and seats in advance, usage in arrears. */
  timing?: 'advance' | 'arrears';
  /** The part of the cycle the line covers (ms, end exclusive), for proration and price book segments. */
  from?: number;
  to?: number;
  /** The plan a plan, seats or proration line is for. */
  planId?: string;
  /** The model a usage line is for, when its item prices one model. */
  model?: string;
}

// ---------- discounts (B-165) ----------

export type DiscountScope = 'plan' | 'seats' | 'meter' | 'model' | 'family' | 'statement';
export type DiscountKind = 'percent' | 'amount' | 'allowance' | 'volume' | 'commitment';
export type DiscountSource = 'rule' | 'promotion' | 'negotiated';

/**
 * A discount's terms, by kind:
 * - `percent`: `percentPpm` off the scope (parts per million: 100000 is 10%).
 * - `amount`: `amountMinor` off the scope, never more than the scope; only on statements in the rule's `currency`.
 * - `allowance`: `quantity` free units of the scope's meter (scope `meter`, `model` or `family`, with `meter` set),
 *   valued at what those units would have cost (the last units priced, so a tiered price is respected).
 * - `volume`: tiers `{ from, percentPpm }`; the highest tier whose `from` the scope reaches gives the percent off the
 *   whole scope (volume, not graduated). `measure` is `quantity` (units of the meter) or `amount` (minor units).
 * - `commitment`: `percentPpm` off the scope when the subscription's cycle is at least `minMonths` long (12 by
 *   default: an annual prepay).
 */
export interface DiscountTerms {
  percentPpm?: number;
  amountMinor?: number;
  quantity?: number;
  meter?: Meter;
  measure?: 'quantity' | 'amount';
  tiers?: { from: number; percentPpm: number }[];
  minMonths?: number;
}

/** Who a rule applies to: every tenant, the tenants listed, or the tenants on the plans listed. */
export type DiscountTarget = { kind: 'all' } | { kind: 'tenants'; ids: string[] } | { kind: 'plans'; ids: string[] };
