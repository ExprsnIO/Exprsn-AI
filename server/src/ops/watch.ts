import type { Services } from '../services.js';
import { RedisCounterStore } from '../platform/ratelimit.js';

/**
 * Sprint 22: per-instance watches started by the server process (not by tests or the CLI): the schema handshake
 * (B-1403), the Redis probe behind the rate-limit warning (B-1407) and a regular NTP measurement for the clock
 * metric (B-1406). Each instance watches its own clock and connections, so these are timers, not jobs. Since 1.6.0
 * (B-4202) also the instance heartbeat behind the Overview (stopped, and its row removed, by `services.close`).
 */
export function startOpsWatch(s: Services): () => void {
  s.schema.start();
  s.instances.start();
  if (s.counters instanceof RedisCounterStore) s.counters.startProbe(s.cfg.RATELIMIT_PROBE_SECONDS * 1000);
  let ntp: NodeJS.Timeout | null = null;
  if (s.cfg.NTP_SERVER) {
    const measure = () => void s.ops.ntpSkew().catch(() => undefined);
    measure();
    ntp = setInterval(measure, 5 * 60_000);
    ntp.unref();
  }
  return () => {
    s.schema.stop();
    if (ntp) clearInterval(ntp);
  };
}
