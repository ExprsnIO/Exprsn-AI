/*
 * Sprint 51 (B-163 to B-165) test helpers: a stand-in subscription source (the engine's narrow `SubscriptionSource`)
 * and the 1.9.0 billing migrations applied to a harness database (idempotent: a no-op once they are registered).
 */
import { up as up125 } from '../src/db/migrations/125_billing_cycles_tiers.js';
import { up as up126 } from '../src/db/migrations/126_billing_discounts.js';
import { cycleBounds } from '../src/billing/cycles.js';
import type { Cycle, SubscriptionAt, SubscriptionPeriod, SubscriptionSource } from '../src/billing/types.js';
import type { Harness } from './helpers.js';

export async function billingSchema(h: Harness): Promise<void> {
  await up125(h.s.db);
  await up126(h.s.db);
}

export interface Stretch {
  from: number;
  to: number;
  planId: string;
  planName: string;
  priceMinor: number;
  seats?: number;
  includedSeats?: number;
  seatPriceMinor?: number;
  allowances?: SubscriptionPeriod['allowances'];
}

/**
 * A subscription for one tenant: a cycle with its origin (the start), and stretches of plan and seats. Periods are
 * cut at every stretch boundary and every cycle boundary; fractions are left to the engine (milliseconds).
 */
export function fakeSubscription(tenantId: string, cycle: Cycle, origin: number, stretches: Stretch[], currency = 'USD'): SubscriptionSource {
  const cut = (from: number, to: number): SubscriptionPeriod[] => {
    const out: SubscriptionPeriod[] = [];
    for (const s of stretches) {
      let a = Math.max(s.from, from);
      const z = Math.min(s.to, to);
      while (a < z) {
        const b = cycleBounds(cycle, origin, a);
        const end = Math.min(z, b.end);
        out.push({ subscriptionId: 'sub_1', planId: s.planId, planName: s.planName, priceMinor: s.priceMinor, seats: s.seats ?? 1, includedSeats: s.includedSeats ?? 1, seatPriceMinor: s.seatPriceMinor ?? 0, allowances: s.allowances ?? {}, cycle, from: a, to: end, periodStart: b.start, periodEnd: b.end });
        a = end;
      }
    }
    return out.sort((x, y) => x.from - y.from);
  };
  return {
    at: async (t, at) => {
      if (t !== tenantId) return null;
      const s = stretches.find((x) => x.from <= at && at < x.to);
      if (!s) return null;
      const b = cycleBounds(cycle, origin, at);
      const sub: SubscriptionAt = { subscriptionId: 'sub_1', planId: s.planId, planName: s.planName, currency, priceMinor: s.priceMinor, seats: s.seats ?? 1, includedSeats: s.includedSeats ?? 1, seatPriceMinor: s.seatPriceMinor ?? 0, allowances: s.allowances ?? {}, cycle, periodStart: b.start, periodEnd: b.end };
      return sub;
    },
    periods: async (t, from, to) => (t === tenantId ? cut(from, to) : [])
  };
}

export const utc = (y: number, m: number, d = 1, h = 0): number => Date.UTC(y, m - 1, d, h);

/** A usage record at a moment. */
export const use = (h: Harness, ts: number, o: { kind?: string; model?: string | null; promptTokens?: number; outputTokens?: number; gpuMs?: number }) =>
  h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: (o.kind ?? 'chat') as 'chat', model: o.model === undefined ? 'llama3.1:8b' : o.model, promptTokens: o.promptTokens ?? 0, outputTokens: o.outputTokens ?? 0, gpuMs: o.gpuMs ?? 0, ts });

export const promptItem = (unitPriceMicros: number, extra: Record<string, unknown> = {}) => ({ match: 'any' as const, value: null, usage: '*', meter: 'prompt_tokens' as const, perUnits: 1_000_000, unitPriceMicros, ...extra });
