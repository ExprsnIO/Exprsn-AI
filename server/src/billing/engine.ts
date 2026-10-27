/*
 * 1.9.0, Sprint 51 (B-163 to B-165): the cycle statement engine. Pure functions over what `BillingService.compute`
 * read: the usage groups of the window (by price book segment and subscription coverage), the subscription's
 * periods, the price book items, the discount rules and the tax rates. It makes the statement's `ChargeLine`s
 * (`billing/types.ts`) and their totals.
 *
 * Order: plan and seats in advance, proration, usage beyond the allowances in arrears (with minimums and caps),
 * discounts in stacking order within the cap, then tax on the subtotal after discounts.
 *
 * Rounding: every line is rounded once to a whole minor unit, half away from zero (`toWholeMinor`, `prorate`), and
 * the totals are sums of lines, so they are exact.
 */
import { addFractions, fraction, minorStep, mulDiv, prorate, toWholeMinor } from './cycles.js';
import { modelInScope, type DiscountRule } from './discounts.js';
import { METERS, priceFor, type Meter, type PriceItem, type StatementTax } from './service.js';
import { isPlainItem, itemKey, minimumOrCap, priceItemCycle, pricingOf, type ItemUse } from './tiers.js';
import type { ChargeLine, Fraction, SubscriptionPeriod } from './types.js';

export interface UsageGroup {
  /** The segment of the window the group's usage falls in (ms, end exclusive). */
  from: number;
  to: number;
  /** Whether a subscription covers the segment (only covered usage uses the plan's allowances). */
  covered: boolean;
  /** The price book version's items in effect for the segment, or null with no book. */
  items: PriceItem[] | null;
  kind: string;
  model: string | null;
  profile: string | null;
  q: Record<Meter, number>;
}

export interface Cap {
  capPercentPpm: number | null;
  capAmountMinor: number | null;
}

export interface CycleInput {
  currency: string;
  /** Minor digits of the currency (2 for USD, 0 for JPY). */
  digits: number;
  window: { from: number; to: number };
  groups: UsageGroup[];
  periods: SubscriptionPeriod[];
  /** Units of each meter included per cycle (the plan in effect at the window's end). */
  allowances: Partial<Record<Meter, number>>;
  /** The book's items at the window's end: their minimums apply even to items with no usage. */
  endItems: PriceItem[];
  taxRates: { name: string; ratePpm: number }[];
  rules: DiscountRule[];
  cap: Cap;
  /** The subscription cycle's length in months, for commitment discounts; null without one. */
  cycleMonths: number | null;
}

export interface CycleResult {
  charges: ChargeLine[];
  subtotal: number;
  discount: number;
  tax: number;
  taxes: StatementTax[];
  total: number;
  /** What each rule did, for the preview: applied, capped, or why it did not apply. */
  discounts: { ruleId: string; name: string; amount: number; capped: boolean; skipped: string | null }[];
}

/** A line under construction, with the usage detail model discounts need. */
interface Work {
  line: ChargeLine;
  /** Usage lines: quantity per model. */
  models?: Map<string | null, number>;
  net: number;
}

const meterWords = (m: Meter): string => m.replace(/_/g, ' ');
const meterTitle = (m: Meter): string => meterWords(m).replace(/^./, (c) => c.toUpperCase());
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
const span = (from: number, to: number): string => `${day(from)} to ${day(to)}`;
const decimal = (x: number): number => Math.round(x * 1e6) / 1e6;

/** An item's per-unit rate for ordering (micros per unit): the first tier's for tiered items. */
const rateOf = (it: PriceItem): number => (pricingOf(it) === 'graduated' || pricingOf(it) === 'volume' ? (it.tiers?.[0]?.unitPriceMicros ?? 0) : it.unitPriceMicros) / it.perUnits;

const itemText = (it: PriceItem): string => `${it.match === 'model' ? ` for ${it.value}` : it.match === 'profile' ? ` for profile ${it.value}` : ''}${it.usage !== '*' ? `, ${it.usage}` : ''}`;

// ---------- plan, seats and proration ----------

const fracOf = (p: SubscriptionPeriod): Fraction => p.fraction ?? fraction(p.to - p.from, p.periodEnd - p.periodStart);

/**
 * Plan and seat lines for the subscription periods of a window. Per cycle: the plan and the seats above the
 * included ones from the first period, for the rest of the cycle the subscription covers (in advance); then, at each
 * change, a credit for the old plan or seats and a charge for the new ones over what is left (proration). The
 * charges add up to `Σ price × fraction` of each period, each line rounded to a minor unit.
 */
export function planCharges(periods: readonly SubscriptionPeriod[], digits: number): ChargeLine[] {
  const step = minorStep(digits);
  const micros = (minor: number) => minor * step;
  const out: ChargeLine[] = [];
  const cycles = new Map<string, SubscriptionPeriod[]>();
  for (const p of [...periods].sort((a, b) => a.from - b.from)) {
    const k = `${p.subscriptionId}|${p.periodStart}|${p.periodEnd}`;
    cycles.set(k, [...(cycles.get(k) ?? []), p]);
  }
  for (const ps of cycles.values()) {
    const rem = ps.map((_, i) => addFractions(ps.slice(i).map(fracOf)));
    const p0 = ps[0]!;
    const end = ps.at(-1)!.to;
    const state = (p: SubscriptionPeriod) => ((p as { state?: string }).state && (p as { state?: string }).state !== 'active' ? ` (${(p as { state?: string }).state})` : '');
    out.push({ kind: 'plan', description: `${p0.planName} plan${state(p0)}, ${span(p0.from, end)}`, quantity: decimal(rem[0]!.num / rem[0]!.den), unit: 'cycle', unitAmount: micros(p0.priceMinor), amount: prorate(micros(p0.priceMinor), rem[0]!, digits), timing: 'advance', from: p0.from, to: end, planId: p0.planId });
    const extra = (p: SubscriptionPeriod) => Math.max(0, p.seats - p.includedSeats);
    if (extra(p0) > 0) out.push({ kind: 'seats', description: `${extra(p0)} seats above the ${p0.includedSeats} included, ${span(p0.from, end)}`, quantity: extra(p0), unit: 'seat', unitAmount: micros(p0.seatPriceMinor), amount: prorate(micros(extra(p0) * p0.seatPriceMinor), rem[0]!, digits), timing: 'advance', from: p0.from, to: end, planId: p0.planId });
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1]!;
      const b = ps[i]!;
      const r = rem[i]!;
      if (a.planId !== b.planId || a.priceMinor !== b.priceMinor) {
        const credit = prorate(micros(a.priceMinor), r, digits);
        const charge = prorate(micros(b.priceMinor), r, digits);
        if (credit) out.push({ kind: 'proration', description: `Unused ${a.planName} plan${state(a)}, ${span(b.from, end)}`, quantity: -decimal(r.num / r.den), unit: 'cycle', unitAmount: micros(a.priceMinor), amount: -credit, timing: 'advance', from: b.from, to: end, planId: a.planId });
        if (charge) out.push({ kind: 'proration', description: `${b.planName} plan${state(b)}, ${span(b.from, end)}`, quantity: decimal(r.num / r.den), unit: 'cycle', unitAmount: micros(b.priceMinor), amount: charge, timing: 'advance', from: b.from, to: end, planId: b.planId });
      }
      if (extra(a) !== extra(b) || a.seatPriceMinor !== b.seatPriceMinor) {
        const credit = prorate(micros(extra(a) * a.seatPriceMinor), r, digits);
        const charge = prorate(micros(extra(b) * b.seatPriceMinor), r, digits);
        if (credit) out.push({ kind: 'proration', description: `Unused ${extra(a)} seats, ${span(b.from, end)}`, quantity: -extra(a), unit: 'seat', unitAmount: micros(a.seatPriceMinor), amount: -credit, timing: 'advance', from: b.from, to: end, planId: a.planId });
        if (charge) out.push({ kind: 'proration', description: `${extra(b)} seats above the ${b.includedSeats} included, ${span(b.from, end)}`, quantity: extra(b), unit: 'seat', unitAmount: micros(b.seatPriceMinor), amount: charge, timing: 'advance', from: b.from, to: end, planId: b.planId });
      }
    }
  }
  return out;
}

// ---------- usage ----------

interface Entry {
  g: UsageGroup;
  meter: Meter;
  q: number;
  billable: number;
  item: PriceItem;
}

/** Extra free units for a free-allowance discount: of one meter, for the usage a predicate picks. */
export interface ExtraFree {
  meter: Meter;
  quantity: number;
  pick: (model: string | null) => boolean;
}

/**
 * Usage lines beyond the allowances. Allowances are used up by covered usage in order: oldest segment first, then the
 * item with the highest unit rate, then kind, model and profile. What is left is priced per item over the cycle
 * (`priceItemCycle`), then each item's minimum or cap applies.
 */
export function usageCharges(groups: readonly UsageGroup[], allowances: Partial<Record<Meter, number>>, endItems: readonly PriceItem[], digits: number, opts: { segmented: boolean; extra?: ExtraFree } = { segmented: false }): Work[] {
  const entries: Entry[] = [];
  for (const g of groups) {
    for (const meter of METERS) {
      const q = g.q[meter];
      if (!q) continue;
      const item = g.items ? priceFor(g.items, meter, g.kind, g.model, g.profile) : null;
      if (item) entries.push({ g, meter, q, billable: q, item });
    }
  }
  entries.sort((a, b) => a.g.from - b.g.from || rateOf(b.item) - rateOf(a.item) || a.g.kind.localeCompare(b.g.kind) || String(a.g.model).localeCompare(String(b.g.model)) || String(a.g.profile).localeCompare(String(b.g.profile)));
  const left: Partial<Record<Meter, number>> = { ...allowances };
  for (const e of entries) {
    if (!e.g.covered) continue;
    const take = Math.min(left[e.meter] ?? 0, e.billable);
    if (take > 0) {
      e.billable -= take;
      left[e.meter] = (left[e.meter] ?? 0) - take;
    }
  }
  if (opts.extra) {
    let free = opts.extra.quantity;
    for (const e of entries) {
      if (e.meter !== opts.extra.meter || !opts.extra.pick(e.g.model) || free <= 0) continue;
      const take = Math.min(free, e.billable);
      e.billable -= take;
      free -= take;
    }
  }
  // Per item (across versions), per segment.
  const byItem = new Map<string, { uses: (ItemUse & { models: Map<string | null, number> })[] }>();
  for (const e of entries) {
    const k = itemKey(e.item);
    const slot = byItem.get(k) ?? { uses: [] };
    byItem.set(k, slot);
    let use = slot.uses.find((u) => u.from === e.g.from);
    if (!use) {
      use = { item: e.item, quantity: 0, from: e.g.from, to: e.g.to, models: new Map() };
      slot.uses.push(use);
    }
    use.quantity += e.billable;
    if (e.billable > 0) use.models.set(e.g.model, (use.models.get(e.g.model) ?? 0) + e.billable);
  }
  const out: Work[] = [];
  const keys = [...byItem.keys()];
  for (const it of endItems) if ((it.minimumMicros ?? 0) > 0 && !byItem.has(itemKey(it))) keys.push(itemKey(it));
  // Lines by meter in catalogue order, then by item (first priced first).
  const meterOf = (k: string) => METERS.indexOf((JSON.parse(k) as string[])[3] as Meter);
  keys.sort((x, y) => meterOf(x) - meterOf(y));
  for (const k of keys) {
    const uses = (byItem.get(k)?.uses ?? []).sort((a, b) => a.from - b.from);
    const lastItem = endItems.find((x) => itemKey(x) === k) ?? uses.at(-1)?.item;
    if (!lastItem) continue;
    const allowance = allowances[lastItem.meter] ?? 0;
    let itemTotal = 0;
    for (const piece of priceItemCycle(uses)) {
      const use = uses.find((u) => u.from === piece.from)!;
      const amount = toWholeMinor(piece.amountMicros, digits);
      itemTotal += amount;
      const share = use.quantity > 0 ? piece.quantity / use.quantity : 0;
      const models = new Map([...use.models].map(([m, n]) => [m, n * share]));
      const tiers = piece.item.tiers?.length ?? 0;
      const pkg = pricingOf(piece.item) === 'package';
      const line: ChargeLine = {
        kind: 'usage',
        description: `${meterTitle(piece.item.meter)}${itemText(piece.item)}${allowance ? ` beyond the ${allowance} included` : ''}${piece.tier ? `, tier ${piece.tier} of ${tiers}` : ''}${pkg ? `, ${piece.blocks} blocks` : ''}${opts.segmented ? `, ${span(piece.from, piece.to)}` : ''}`,
        quantity: pkg ? (piece.blocks ?? 0) : decimal(piece.quantity / piece.perUnits),
        unit: `${pkg ? 'block of ' : ''}${piece.perUnits} ${meterWords(piece.item.meter)}`,
        unitAmount: piece.unitPriceMicros,
        amount,
        meter: piece.item.meter,
        ...(piece.tier ? { tier: piece.tier } : {}),
        timing: 'arrears',
        ...(opts.segmented ? { from: piece.from, to: piece.to } : {}),
        ...(piece.item.match === 'model' && piece.item.value ? { model: piece.item.value } : {})
      };
      out.push({ line, models, net: amount });
    }
    const adj = minimumOrCap(lastItem, itemTotal);
    if (adj) {
      const amount = toWholeMinor(adj.amountMicros, digits);
      if (amount) out.push({ line: { kind: 'usage', description: `${meterTitle(lastItem.meter)}${itemText(lastItem)}: ${adj.tier === 'minimum' ? 'the cycle minimum' : 'the cycle cap'} of ${(adj.tier === 'minimum' ? lastItem.minimumMicros! : lastItem.capMicros!) / 1e6}`, quantity: 1, unit: 'cycle', unitAmount: amount, amount, meter: lastItem.meter, tier: adj.tier, timing: 'arrears' }, net: amount });
    }
  }
  return out;
}

const usageTotal = (ws: readonly Work[], meter?: Meter): number => ws.filter((w) => !meter || w.line.meter === meter).reduce((a, w) => a + w.line.amount, 0);

// ---------- discounts ----------

/** The part of a line in a rule's scope (0 to 1), and the quantity of the scope it carries. */
function weightOf(w: Work, r: DiscountRule): { weight: number; quantity: number } {
  const l = w.line;
  if (l.kind === 'discount' || l.kind === 'tax' || l.kind === 'credit') return { weight: 0, quantity: 0 };
  switch (r.scope) {
    case 'statement':
      return { weight: 1, quantity: 0 };
    case 'plan':
      return { weight: l.kind === 'plan' || (l.kind === 'proration' && l.unit === 'cycle') ? 1 : 0, quantity: 0 };
    case 'seats':
      return { weight: l.kind === 'seats' || (l.kind === 'proration' && l.unit === 'seat') ? 1 : 0, quantity: 0 };
    case 'meter': {
      const on = l.kind === 'usage' && l.meter === r.scopeValue;
      const units = on && l.tier !== 'minimum' && l.tier !== 'cap' && w.models ? [...w.models.values()].reduce((a, n) => a + n, 0) : 0;
      return { weight: on ? 1 : 0, quantity: units };
    }
    case 'model':
    case 'family': {
      if (l.kind !== 'usage' || !w.models || (r.terms.meter && l.meter !== r.terms.meter)) return { weight: 0, quantity: 0 };
      let all = 0;
      let mine = 0;
      for (const [m, n] of w.models) {
        all += n;
        if (modelInScope(r.scope, r.scopeValue, m)) mine += n;
      }
      return { weight: all > 0 ? mine / all : 0, quantity: mine };
    }
  }
}

/** Splits `amount` (a multiple of `step`) over shares in whole steps, largest remainder first. */
function allocate(amount: number, shares: readonly number[], step: number): number[] {
  const total = shares.reduce((a, x) => a + x, 0);
  if (total <= 0 || amount === 0) return shares.map(() => 0);
  const units = Math.round(amount / step);
  const raw = shares.map((x) => (units * x) / total);
  const out = raw.map((x) => Math.floor(x));
  let restUnits = units - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (restUnits <= 0) break;
    out[i]! += 1;
    restUnits -= 1;
  }
  return out.map((x) => x * step);
}

export interface DiscountContext {
  currency: string;
  digits: number;
  cap: Cap;
  cycleMonths: number | null;
  /** What `quantity` more free units of a meter (for the usage `pick` chooses) would take off the usage. */
  freeValue: (extra: ExtraFree) => number;
}

/**
 * Applies rules in their order. Each takes its share off the scope as it stands after the rules before it (so two
 * 10% rules make 19%, not 20%), never more than the scope, and never more than the room left under the cap (the
 * smaller of `capPercentPpm` of the pre-discount total and `capAmountMinor`). A rule's amount is rounded to a whole
 * minor unit, half away from zero, and spread over the lines of its scope in whole minor units (largest remainder),
 * so the next rule sees what is left of each line.
 */
export function applyDiscounts(work: Work[], rules: readonly DiscountRule[], ctx: DiscountContext): { lines: ChargeLine[]; report: CycleResult['discounts'] } {
  const step = minorStep(ctx.digits);
  const pre = Math.max(0, work.reduce((a, w) => a + w.line.amount, 0));
  const caps = [ctx.cap.capPercentPpm != null ? mulDiv(pre, ctx.cap.capPercentPpm, 1_000_000 * step) * step : null, ctx.cap.capAmountMinor != null ? ctx.cap.capAmountMinor * step : null].filter((x): x is number => x != null);
  let room = caps.length ? Math.min(...caps) : Infinity;
  const lines: ChargeLine[] = [];
  const report: CycleResult['discounts'] = [];
  for (const r of rules) {
    const skip = (why: string) => report.push({ ruleId: r.id, name: r.name, amount: 0, capped: false, skipped: why });
    if (r.kind === 'amount' && r.currency && r.currency !== ctx.currency) {
      skip(`the rule is in ${r.currency}; the statement is in ${ctx.currency}`);
      continue;
    }
    if (r.kind === 'commitment' && !(ctx.cycleMonths != null && ctx.cycleMonths >= (r.terms.minMonths ?? 12))) {
      skip(`a commitment discount needs a cycle of ${r.terms.minMonths ?? 12} months or more`);
      continue;
    }
    const ws = work.map((w) => weightOf(w, r));
    const shares = work.map((w, i) => Math.max(0, ws[i]!.weight * w.net));
    const base = Math.max(0, toWholeMinor(shares.reduce((a, x) => a + x, 0), ctx.digits));
    if (base <= 0) {
      skip('nothing in its scope on this statement');
      continue;
    }
    let want: number;
    let unit = 'discount';
    let unitAmount: number;
    let detail: string;
    if (r.kind === 'percent' || r.kind === 'commitment') {
      want = mulDiv(base, r.terms.percentPpm!, 1_000_000 * step) * step;
      unit = 'percent';
      unitAmount = r.terms.percentPpm!;
      detail = `${r.terms.percentPpm! / 10_000}% off ${scopeText(r)}`;
    } else if (r.kind === 'amount') {
      want = r.terms.amountMinor! * step;
      unitAmount = -want;
      detail = `${(r.terms.amountMinor! * step) / 1e6} off ${scopeText(r)}`;
    } else if (r.kind === 'volume') {
      const measure = r.terms.measure ?? 'amount';
      const reached = measure === 'quantity' ? ws.reduce((a, x) => a + x.quantity, 0) : base / step;
      const tier = [...(r.terms.tiers ?? [])].reverse().find((t) => reached >= t.from);
      if (!tier) {
        skip(`the scope reached ${decimal(reached)} ${measure === 'quantity' ? 'units' : 'minor units'}, below the first tier`);
        continue;
      }
      want = mulDiv(base, tier.percentPpm, 1_000_000 * step) * step;
      unit = 'percent';
      unitAmount = tier.percentPpm;
      detail = `${tier.percentPpm / 10_000}% off ${scopeText(r)} (volume tier from ${tier.from})`;
    } else {
      const meter = (r.scope === 'meter' ? r.scopeValue : r.terms.meter) as Meter;
      want = toWholeMinor(ctx.freeValue({ meter, quantity: r.terms.quantity!, pick: (m) => r.scope === 'meter' || modelInScope(r.scope, r.scopeValue, m) }), ctx.digits);
      unitAmount = -want;
      detail = `${r.terms.quantity} free ${meterWords(meter)}${r.scope !== 'meter' ? ` for ${r.scopeValue}` : ''}`;
    }
    want = Math.min(want, base);
    const amount = Math.max(0, Math.min(want, room));
    const capped = amount < want;
    if (amount <= 0) {
      report.push({ ruleId: r.id, name: r.name, amount: 0, capped, skipped: capped ? 'the discount cap is reached' : 'it comes to nothing' });
      continue;
    }
    room -= amount;
    const parts = allocate(amount, shares, step);
    parts.forEach((x, i) => (work[i]!.net -= x));
    lines.push({ kind: 'discount', description: `${r.name}: ${detail}${capped ? ', limited by the discount cap' : ''}`, quantity: 1, unit, unitAmount, amount: -amount, ruleId: r.id });
    report.push({ ruleId: r.id, name: r.name, amount: -amount, capped, skipped: null });
  }
  return { lines, report };
}

const scopeText = (r: DiscountRule): string => (r.scope === 'statement' ? 'the statement' : r.scope === 'plan' ? 'the plan' : r.scope === 'seats' ? 'seats' : r.scope === 'meter' ? meterWords(r.scopeValue as Meter) : `${r.scope === 'family' ? 'the ' : ''}${r.scopeValue}${r.scope === 'family' ? ' family' : ''}`);

// ---------- the statement ----------

/** Whether a window prices exactly as before 1.9.0 (the money in `lines`): see `BillingService.compute`. */
export const plainItems = (groups: readonly UsageGroup[]): boolean => groups.every((g) => !g.items || g.items.every(isPlainItem));

export function computeCycle(input: CycleInput): CycleResult {
  const { digits } = input;
  const segmented = new Set(input.groups.map((g) => g.from)).size > 1;
  const work: Work[] = planCharges(input.periods, digits).map((line) => ({ line, net: line.amount }));
  const usage = usageCharges(input.groups, input.allowances, input.endItems, digits, { segmented });
  work.push(...usage);
  const freeValue = (extra: ExtraFree) => {
    const less = usageCharges(input.groups, input.allowances, input.endItems, digits, { segmented, extra });
    return usageTotal(usage, extra.meter) - usageTotal(less, extra.meter);
  };
  const { lines: discounts, report } = applyDiscounts(work, input.rules, { currency: input.currency, digits, cap: input.cap, cycleMonths: input.cycleMonths, freeValue });
  const charges = [...work.map((w) => w.line), ...discounts];
  const subtotal = charges.reduce((a, l) => a + l.amount, 0);
  const discount = discounts.reduce((a, l) => a + l.amount, 0);
  const taxes: StatementTax[] = input.taxRates.map((r) => ({ name: r.name, ratePpm: r.ratePpm, amountMicros: mulDiv(subtotal, r.ratePpm, 1_000_000 * minorStep(digits)) * minorStep(digits) }));
  for (const x of taxes) charges.push({ kind: 'tax', description: `${x.name} ${(x.ratePpm / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`, quantity: 1, unit: 'percent', unitAmount: x.ratePpm, amount: x.amountMicros });
  const tax = taxes.reduce((a, x) => a + x.amountMicros, 0);
  return { charges, subtotal, discount, tax, taxes, total: subtotal + tax, discounts: report };
}
