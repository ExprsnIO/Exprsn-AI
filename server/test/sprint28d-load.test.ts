/*
 * Sprint 28 (B-2105): the two fixes the platform load test (server/loadtest/platform.ts) found. The database job queue
 * keeps its slots full instead of waiting for a whole batch at every poll, so one slow job no longer holds the others
 * back; and a hanging webhook endpoint counts every failed attempt (they run at the same time), opens its breaker once,
 * and gets at most half the job slots while it is failing, so the other endpoints keep their deliveries flowing.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, localUser, type Harness } from './helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

describe('B-2105: the database job queue under load', () => {
  let h: Harness;
  afterEach(async () => {
    await h.s.jobs.stop();
    await h.close();
  });

  it('fills free slots at once: a slow job does not hold the others until the next poll', async () => {
    h = await harness({ JOB_CONCURRENCY: '4', JOB_POLL_MS: '5000' });
    const done: string[] = [];
    h.s.jobs.register('load.slow', async () => {
      await sleep(3000);
      done.push('slow');
    });
    h.s.jobs.register('load.fast', async (p) => {
      done.push(String(p.n));
    });
    h.s.jobs.start();
    await sleep(50); // the first poll found nothing
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'load.slow', payload: {} });
    const t0 = Date.now();
    for (let n = 0; n < 30; n++) await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'load.fast', payload: { n } });
    // Before 1.4.0 these waited for the next poll (5 s) and then for the slow job in the same batch.
    await until(() => done.filter((x) => x !== 'slow').length === 30, 'the fast jobs', 2500);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(done).not.toContain('slow');
  });
});

describe('B-2105: a hanging webhook endpoint is isolated', () => {
  let h: Harness;
  let receiver: Server;
  afterEach(async () => {
    await h.s.jobs.stop();
    receiver.closeAllConnections();
    await new Promise((r) => receiver.close(r));
    await h.close();
  });

  it('counts concurrent failures, opens the breaker once and caps the endpoint while the others are delivered', async () => {
    h = await harness({ JOB_CONCURRENCY: '4', JOB_POLL_MS: '200', WEBHOOK_TIMEOUT_MS: '400', WEBHOOK_BREAKER_THRESHOLD: '5', WEBHOOK_BREAKER_COOLDOWN_MS: '60000', WEBHOOK_RETRY_BASE_MS: '60000' });
    const hits = { slow: 0, fast: 0 };
    receiver = createServer((req, res) => {
      req.resume();
      if (req.url === '/slow') {
        hits.slow++;
        return; // never answers: every attempt times out
      }
      hits.fast++;
      req.on('end', () => res.writeHead(204).end());
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const u = await localUser(h, 'hooks', ['tenant-admin']);
    const slow = (await h.s.webhooks.create(h.tenantId, u.id, { name: 'slow', url: `${base}/slow`, events: ['demo.*'], maxLabel: 'internal' })).row;
    await h.s.webhooks.create(h.tenantId, u.id, { name: 'fast', url: `${base}/fast`, events: ['demo.*'], maxLabel: 'internal' });
    h.s.jobs.start();

    for (let i = 0; i < 30; i++) {
      await h.s.webhooks.emit(h.tenantId, 'demo.event', 'internal', `demo:${i}`, {});
      await sleep(30);
    }
    await until(() => hits.fast === 30, 'the healthy endpoint’s deliveries');
    await until(async () => (await h.s.db('webhooks').where({ id: slow.id }).first()).breaker === 'open', 'the breaker to open');
    await sleep(1000); // attempts in flight when it opened finish
    const row = await h.s.db('webhooks').where({ id: slow.id }).first();
    // Every failed attempt counted, even those that ran at the same time.
    expect(Number(row.failures)).toBe(hits.slow);
    // The threshold, plus at most the attempts already in flight when the breaker opened.
    expect(hits.slow).toBeGreaterThanOrEqual(5);
    expect(hits.slow).toBeLessThanOrEqual(5 + 3);
    const opened = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'webhook.breaker.opened' });
    expect(opened).toHaveLength(1);
    // The rest wait for the cool-down instead of hitting the endpoint.
    const pending = (await h.s.db('webhook_deliveries').where({ webhook_id: slow.id, state: 'pending' })) as { next_attempt_at: number | string }[];
    expect(pending.length).toBeGreaterThan(20);
    expect(pending.every((d) => Number(d.next_attempt_at) > Date.now() + 30_000)).toBe(true);
  });
});
