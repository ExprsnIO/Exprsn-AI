/*
 * 1.9.0, Sprint 51 (B-164): tiered pricing of one price book item over one cycle. Pure functions.
 *
 * A cycle may be split into segments by price book versions (B-1505); each segment is priced by its own version of
 * the item, and the tier position carries over from one segment to the next, so a price change in the middle of a
 * cycle does not restart the tiers:
 *
 * - graduated: the units of a later segment continue up the ladder from where the earlier segments left it;
 * - volume: the cycle's whole quantity picks the tier, and each segment prices its units at its version's price for
 *   that tier;
 * - package: blocks are counted on the cumulative quantity, so the cycle pays `ceil(total / perUnits)` blocks in all,
 *   each segment paying for the blocks it starts.
 *
 * Rounding: a piece's amount is `quantity × price / perUnits`, rounded half up to the micro (as flat prices always
 * were); the statement rounds each line to a minor unit when it makes the line.
 */
import type { PriceItem } from './service.js';
import type { PriceTier, PricingModel } from './types.js';

export interface ItemUse {
  item: PriceItem;
  quantity: number;
  from: number;
  to: number;
}

export interface PricedPiece {
  item: PriceItem;
  quantity: number;
  amountMicros: number;
  /** 1-based tier number (graduated, volume), absent for flat and package. */
  tier?: number;
  /** Micros per `perUnits` units (per block for a package). */
  unitPriceMicros: number;
  perUnits: number;
  from: number;
  to: number;
  /** For a package: the blocks this piece pays for. */
  blocks?: number;
}

export const pricingOf = (it: Pick<PriceItem, 'pricing'>): PricingModel => it.pricing ?? 'flat';

/** An item's identity across price book versions: what it matches, not what it charges. */
export const itemKey = (it: Pick<PriceItem, 'match' | 'value' | 'usage' | 'meter'>): string => JSON.stringify([it.match, it.value, it.usage, it.meter]);

/** Whether an item prices exactly as before 1.9.0: flat, no minimum, no cap. */
export const isPlainItem = (it: PriceItem): boolean => pricingOf(it) === 'flat' && it.minimumMicros == null && it.capMicros == null;

const amountOf = (quantity: number, price: number, perUnits: number): number => Math.round((quantity * price) / perUnits);

/** The 0-based tier a quantity falls in (bounds inclusive). */
export function tierIndex(tiers: readonly PriceTier[], quantity: number): number {
  for (const [i, t] of tiers.entries()) if (t.upTo == null || quantity <= t.upTo) return i;
  return tiers.length - 1;
}

/** Prices one item's uses over a cycle, oldest segment first. */
export function priceItemCycle(uses: readonly ItemUse[]): PricedPiece[] {
  const out: PricedPiece[] = [];
  const total = uses.reduce((a, u) => a + u.quantity, 0);
  let pos = 0;
  const flatPaid = new Set<number>();
  for (const [ui, u] of uses.entries()) {
    const it = u.item;
    const q = u.quantity;
    const model = pricingOf(it);
    if (q <= 0) continue;
    if (model === 'flat') {
      out.push({ item: it, quantity: q, amountMicros: amountOf(q, it.unitPriceMicros, it.perUnits), unitPriceMicros: it.unitPriceMicros, perUnits: it.perUnits, from: u.from, to: u.to });
    } else if (model === 'package') {
      const blocks = Math.ceil((pos + q) / it.perUnits - 1e-9) - Math.ceil(pos / it.perUnits - 1e-9);
      out.push({ item: it, quantity: q, amountMicros: blocks * it.unitPriceMicros, unitPriceMicros: it.unitPriceMicros, perUnits: it.perUnits, from: u.from, to: u.to, blocks });
    } else if (model === 'graduated') {
      const tiers = it.tiers ?? [];
      let lower = 0;
      for (const [i, t] of tiers.entries()) {
        const upper = t.upTo ?? Infinity;
        const inTier = Math.max(0, Math.min(pos + q, upper) - Math.max(pos, lower));
        if (inTier > 0) {
          const flat = t.flatMicros && !flatPaid.has(i) ? t.flatMicros : 0;
          if (flat) flatPaid.add(i);
          out.push({ item: it, quantity: inTier, amountMicros: amountOf(inTier, t.unitPriceMicros, it.perUnits) + flat, tier: i + 1, unitPriceMicros: t.unitPriceMicros, perUnits: it.perUnits, from: u.from, to: u.to });
        }
        lower = upper;
        if (lower >= pos + q) break;
      }
    } else {
      const tiers = it.tiers ?? [];
      const i = tierIndex(tiers, total);
      const t = tiers[i]!;
      // The tier's fixed amount once per cycle, with the last segment that has usage.
      const last = uses.slice(ui + 1).every((x) => x.quantity <= 0);
      out.push({ item: it, quantity: q, amountMicros: amountOf(q, t.unitPriceMicros, it.perUnits) + (last && t.flatMicros ? t.flatMicros : 0), tier: i + 1, unitPriceMicros: t.unitPriceMicros, perUnits: it.perUnits, from: u.from, to: u.to });
    }
    pos += q;
  }
  return out;
}

/** The adjustment a cycle's minimum or cap makes to an item's total (micros), or null. */
export function minimumOrCap(it: Pick<PriceItem, 'minimumMicros' | 'capMicros'>, totalMicros: number): { tier: 'minimum' | 'cap'; amountMicros: number } | null {
  if (it.minimumMicros != null && totalMicros < it.minimumMicros) return { tier: 'minimum', amountMicros: it.minimumMicros - totalMicros };
  if (it.capMicros != null && totalMicros > it.capMicros) return { tier: 'cap', amountMicros: it.capMicros - totalMicros };
  return null;
}

/** A price book item's pricing as text: "graduated, 3 tiers", "per block of 1000". */
export const pricingText = (it: PriceItem): string => {
  const m = pricingOf(it);
  return m === 'flat' ? 'flat' : m === 'package' ? `per block of ${it.perUnits}` : `${m}, ${(it.tiers ?? []).length} tiers`;
};
