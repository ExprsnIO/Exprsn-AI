import client from 'prom-client';
import type { Provider } from './types.js';
import type { ApiClass, BreakerState, CallOutcome, TransportMetrics, WaitReason } from './providers/transport.js';

/*
 * 1.9.99-final, Sprint 57 (B-10108): the cloud transport's Prometheus metrics, registered once per registry (the way
 * `observability/ops-metrics.ts` does it). Labels are the provider, the API class, the reason or the outcome; an
 * account appears only as a count of open breakers, never as a label value of its own.
 *
 *   exprsn_cloud_wait_seconds{provider,api_class,reason}   histogram of waits: limiter (a bucket was spent), retry
 *                                                         (throttling or a retried failure), hold (a provider said
 *                                                         its allowance was low)
 *   exprsn_cloud_calls_total{provider,api_class,outcome}  calls by outcome: ok, error, throttled, unreachable,
 *                                                         refused (egress), rate_limited (refused locally),
 *                                                         circuit_open
 *   exprsn_cloud_breaker_transitions_total{provider,to}   breaker changes
 *   exprsn_cloud_breakers_open{provider}                  accounts whose breaker is open or half-open now
 */

const byRegistry = new WeakMap<client.Registry, TransportMetrics>();

export function cloudTransportMetrics(registry: client.Registry): TransportMetrics {
  const have = byRegistry.get(registry);
  if (have) return have;
  const registers = [registry];
  const wait = new client.Histogram({
    name: 'exprsn_cloud_wait_seconds',
    help: 'Time cloud provider calls waited, by provider, API class and reason (limiter, retry, hold) (B-10108)',
    labelNames: ['provider', 'api_class', 'reason'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers
  });
  const calls = new client.Counter({ name: 'exprsn_cloud_calls_total', help: 'Cloud provider calls by provider, API class and outcome (B-10108)', labelNames: ['provider', 'api_class', 'outcome'], registers });
  const transitions = new client.Counter({ name: 'exprsn_cloud_breaker_transitions_total', help: 'Cloud circuit breaker changes by provider and new state (B-10108)', labelNames: ['provider', 'to'], registers });
  const open = new Map<string, BreakerState>();
  new client.Gauge({
    name: 'exprsn_cloud_breakers_open',
    help: 'Cloud accounts whose circuit breaker is open or half-open, by provider (B-10108)',
    labelNames: ['provider'],
    registers,
    collect() {
      this.reset();
      const n: Record<string, number> = {};
      for (const [k, st] of open) if (st !== 'closed') n[k.split('|')[0]!] = (n[k.split('|')[0]!] ?? 0) + 1;
      for (const p of ['aws', 'azure', 'digitalocean', 'cloudflare']) this.set({ provider: p }, n[p] ?? 0);
    }
  });
  const m: TransportMetrics = {
    waited(provider: Provider, apiClass: ApiClass, reason: WaitReason, ms: number) {
      wait.observe({ provider, api_class: apiClass, reason }, ms / 1000);
    },
    called(provider: Provider, apiClass: ApiClass, outcome: CallOutcome) {
      calls.inc({ provider, api_class: apiClass, outcome });
    },
    breaker(provider: Provider, accountId: string, _from: BreakerState, to: BreakerState) {
      transitions.inc({ provider, to });
      if (to === 'closed') open.delete(`${provider}|${accountId}`);
      else open.set(`${provider}|${accountId}`, to);
    }
  };
  byRegistry.set(registry, m);
  return m;
}
