import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisCounterStore } from '../src/platform/ratelimit.js';

/** A port with nothing behind it: listen, note the port, close. */
async function deadPort(): Promise<number> {
  const s: Server = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('Redis counters while Redis is down from the start (1.3.2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('waits briefly for a first connection only in the first seconds, then never delays a hit', async () => {
    const store = new RedisCounterStore(`redis://127.0.0.1:${await deadPort()}`);
    try {
      // In the start-up window a hit waits at most about 250 ms, then counts in memory.
      let t = performance.now();
      expect((await store.hit('k', 60_000)).count).toBe(1);
      expect(performance.now() - t).toBeLessThan(1_000);

      // After the window, with Redis still unreachable, hits fall back at once instead of waiting each time.
      const start = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => start + 10_000);
      t = performance.now();
      for (let i = 0; i < 5; i++) await store.hit('k', 60_000);
      expect(performance.now() - t).toBeLessThan(200);
      expect(store.health().degraded).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await store.close();
    }
  });
});
