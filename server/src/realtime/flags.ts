import { FLAGS_TOPIC } from '../flags/service.js';
import type { Bus } from '../platform/bus.js';

/*
 * 1.9.9-qa (B-169, live flag changes): when a flag value changes, the console hears it at once instead of at its next
 * one-minute refetch. A change publishes `feature.flags` on the bus (`FeatureFlagService.changed`, from every write and
 * from plan and subscription changes); every instance hears it and emits `flags.changed` to the sockets it holds:
 *
 * - a change for one tenant (its tenant or workspace values, its plan or subscription) to that tenant's room only;
 * - a platform change (a definition, a platform or plan value, an approved proposal) to every socket.
 *
 * The event carries no key and no value: `{ at }` only, so nobody learns of a flag they are not sent. The console
 * answers by fetching GET /api/me/flags, which evaluates the flags for that person as always. Changes are coalesced
 * per room for `coalesceMs`, so a burst of writes (a bulk change, a rotation) is one refetch, and the emit is
 * `io.local`: the bus already reached every instance, so the Redis adapter must not carry it again.
 */

interface Emitter {
  local: { to(room: string): { emit(ev: string, data: unknown): unknown }; emit(ev: string, data: unknown): unknown };
}

export const FLAGS_EVENT = 'flags.changed';

export function attachFlagEvents(io: Emitter, bus: Pick<Bus, 'on'>, tenantRoom: (id: string) => string, opts: { coalesceMs?: number } = {}): { offs: (() => void)[] } {
  const wait = Math.max(0, opts.coalesceMs ?? 250);
  const timers = new Map<string, NodeJS.Timeout>();
  const fire = (key: string) => {
    timers.delete(key);
    const data = { at: Date.now() };
    if (key === '*') io.local.emit(FLAGS_EVENT, data);
    else io.local.to(tenantRoom(key)).emit(FLAGS_EVENT, data);
  };
  const schedule = (key: string) => {
    // A platform change reaches everyone: the tenant ones waiting are covered by it.
    if (key === '*') {
      for (const [k, t] of [...timers]) {
        if (k === '*') continue;
        clearTimeout(t);
        timers.delete(k);
      }
    } else if (timers.has('*')) return;
    if (timers.has(key)) return;
    if (!wait) return fire(key);
    const t = setTimeout(() => fire(key), wait);
    t.unref?.();
    timers.set(key, t);
  };
  const off = bus.on<{ tenantId?: unknown } | null>(FLAGS_TOPIC, (e) => {
    const tenantId = e && typeof e.tenantId === 'string' && e.tenantId ? e.tenantId : null;
    schedule(tenantId ?? '*');
  });
  return {
    offs: [
      off,
      () => {
        for (const t of timers.values()) clearTimeout(t);
        timers.clear();
      }
    ]
  };
}
